import { APIErrorCode, RpcEvent, RpcMessage, Session } from "../types/connector";
import { openWindow } from "@/utils/uiHelpers";
import { connectedDAppsDbService } from "@/api/database/connectedDAppsDbService";
import {
  getBalance,
  getUTxOs,
  handleAuthRequest,
  handleGetAddressesRequest,
  handleGetChangeAddressRequest,
  handleGetCurrentHeightRequest,
  handleNotImplementedRequest,
  handleSignTxRequest,
  handleSubmitTxRequest
} from "./ergoApiHandlers";
import { AddressState } from "@/types/internal";
import { browser } from "@/utils/browserApi";
import { graphQLService } from "@/api/explorer/graphQlService";
import { onMessage, sendMessage } from "webext-bridge/background";
import { isInternalEndpoint } from "webext-bridge";
import {
  ErrorResult,
  InternalEvent,
  InternalMessagePayload,
  InternalRequest,
  SuccessResult
} from "./messaging";
import { AsyncRequestQueue } from "./asyncRequestQueue";
import { isDefined } from "@fleet-sdk/common";
import { ERG_TOKEN_ID } from "../constants/ergo";

const ORIGIN_MATCHER = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i;

const sessions = new Map<number, Session>();
const requests = new AsyncRequestQueue();

onMessage(InternalRequest.Connect, async ({ data, sender }) => {
  if (!isInternalEndpoint(sender)) return false;

  const authorized = await checkConnection(data.payload.origin);
  if (authorized) return true;

  return await openConnectionWindow(data.payload.origin, sender.tabId);
});

onMessage(InternalRequest.CheckConnection, async ({ sender, data }) => {
  if (!isInternalEndpoint(sender)) return false;

  return await checkConnection(data.payload.origin);
});

onMessage(InternalRequest.Disconnect, async ({ sender, data }) => {
  if (!isInternalEndpoint(sender)) return false;

  await connectedDAppsDbService.deleteByOrigin(data.payload.origin);
  const connected = await checkConnection(data.payload.origin);
  return !connected;
});

const NOT_CONNECTED_ERROR = error(APIErrorCode.InvalidRequest, "Not connected.");

onMessage(InternalRequest.GetUTxOs, async ({ sender, data }) => {
  if (!isInternalEndpoint(sender)) return NOT_CONNECTED_ERROR;

  const connection = await connectedDAppsDbService.getByOrigin(data.payload.origin);
  if (!connection) return NOT_CONNECTED_ERROR;

  const utxos = await getUTxOs(connection.walletId, data.target);
  return success(utxos);
});

onMessage(InternalRequest.GetBalance, async ({ sender, data }) => {
  if (!isInternalEndpoint(sender)) return NOT_CONNECTED_ERROR;

  const connection = await connectedDAppsDbService.getByOrigin(data.payload.origin);
  if (!connection) return NOT_CONNECTED_ERROR;

  const tokenId = !data.tokenId || data.tokenId === "ERG" ? ERG_TOKEN_ID : data.tokenId;
  const balance = await getBalance(connection.walletId, tokenId);
  return success(balance);
});

onMessage(InternalEvent.Loaded, async ({ sender }) => {
  if (!isInternalEndpoint(sender)) return;

  let request = requests.pop();
  while (request) {
    const payload: InternalMessagePayload = {
      origin: request.origin,
      requestId: request.id,
      favicon: request.favicon
    };

    switch (request.type) {
      case InternalRequest.Connect: {
        const granted = await sendMessage(InternalRequest.Connect, { payload }, "popup");
        request.resolve(granted);
        break;
      }
    }

    request = requests.pop();
  }
});

/**
 * Creates a success result object with the specified data.
 *
 * @template T - The type of the data.
 * @param data - The data to be included in the success result.
 * @returns A success result object containing the specified data.
 */
function success<T>(data: T): SuccessResult<T> {
  return { success: true, data };
}

/**
 * Creates an ErrorResult object with the specified API error code and information.
 * @param code - The API error code.
 * @param info - Additional information about the error.
 * @returns An ErrorResult object with the specified error code and information.
 */
function error(code: APIErrorCode, info: string): ErrorResult {
  return { success: false, error: { code, info } };
}

async function openConnectionWindow(origin: string, tabId: number): Promise<boolean> {
  const favicon = await getFavicon(tabId);
  const promise = requests.push<boolean>({ type: InternalRequest.Connect, origin, favicon });
  await openWindow(tabId);
  return promise;
}

async function checkConnection(origin: string): Promise<boolean> {
  const connection = await connectedDAppsDbService.getByOrigin(origin);
  return isDefined(connection) && isDefined(connection?.walletId);
}

async function getFavicon(tabId: number) {
  return (await browser?.tabs.get(tabId))?.favIconUrl;
}

function getHost(url?: string) {
  if (!url) return;

  const matches = url.match(ORIGIN_MATCHER);
  if (matches) return matches[1];
}

browser?.runtime.onConnect.addListener((port) => {
  // eslint-disable-next-line no-console
  console.log(`connected with ${getHost(port.sender?.url)}`);

  if (port.name === "nautilus-ui") {
    port.onMessage.addListener(async (message: RpcMessage | RpcEvent) => {
      if (message.type === "rpc/nautilus-event") {
        switch (message.name) {
          case "updated:graphql-url":
            graphQLService.updateServerUrl(message.data);
            break;
        }
      }
    });
  } else {
    port.onMessage.addListener(async (message: RpcMessage, port) => {
      const origin = getHost(port.sender?.url);
      const tabId = port.sender?.tab?.id;
      if (message.type !== "rpc/connector-request" || !port.sender || !origin || !tabId) {
        return;
      }

      const session = sessions.get(tabId);
      switch (message.function) {
        case "getUsedAddresses":
          await handleGetAddressesRequest(message, port, session, AddressState.Used);
          break;
        case "getUnusedAddresses":
          await handleGetAddressesRequest(message, port, session, AddressState.Unused);
          break;
        case "getChangeAddress":
          await handleGetChangeAddressRequest(message, port, session);
          break;
        case "auth":
          await handleAuthRequest(message, port, session);
          break;
        case "signTxInputs":
        case "signTx":
          await handleSignTxRequest(message, port, session);
          break;
        case "signData":
          await handleNotImplementedRequest(message, port, session);
          break;
        case "getCurrentHeight":
          await handleGetCurrentHeightRequest(message, port, session);
          break;
        case "submitTx":
          await handleSubmitTxRequest(message, port, sessions.get(tabId));
          break;
      }
    });
  }
});
