import AES from "crypto-js/aes";
import utf8Enc from "crypto-js/enc-utf8";
import { isEmpty } from "@fleet-sdk/common";
import { dbContext } from "@/database/dbContext";
import { IDbAddress, IDbWallet } from "@/types/database";
import { AddressState, WalletSettings } from "@/types/internal";
import { PasswordError } from "@/common/errors";

class WalletsDbService {
  public async getById(id: number): Promise<IDbWallet | undefined> {
    return await dbContext.wallets.where("id").equals(id).first();
  }

  public async getFirst(): Promise<IDbWallet | undefined> {
    return await dbContext.wallets.get(1);
  }

  public async getMnemonic(id: number, password: string) {
    const wallet = await this.getById(id);
    if (!wallet) {
      throw Error("wallet not found");
    }
    if (!wallet.mnemonic) {
      throw Error("wallet doesn't have a mnemonic phrase");
    }

    try {
      const mnemonic = AES.decrypt(wallet.mnemonic, password).toString(utf8Enc);
      if (isEmpty(mnemonic)) throw new PasswordError();

      return mnemonic;
    } catch {
      throw new PasswordError();
    }
  }

  public async getFirstUnusedAddress(walletId: number): Promise<IDbAddress | undefined> {
    return await dbContext.addresses
      .where("walletId")
      .equals(walletId)
      .and((a) => a.state === AddressState.Unused)
      .first();
  }

  public async getByPk(publicKey: string): Promise<IDbWallet | undefined> {
    return await dbContext.wallets.where("publicKey").equals(publicKey).first();
  }

  public async put(wallet: IDbWallet): Promise<number> {
    const dbWallet = await this.getByPk(wallet.publicKey);
    if (!wallet.id) wallet.id = dbWallet?.id;

    return dbContext.wallets.put(wallet);
  }

  public async updateSettings(
    walletId: number,
    walletName: string,
    settings: WalletSettings
  ): Promise<number> {
    return await dbContext.wallets.update(walletId, {
      name: walletName.trim(),
      "settings.avoidAddressReuse": settings.avoidAddressReuse,
      "settings.hideUsedAddresses": settings.hideUsedAddresses
    });
  }

  public async updateChangeIndex(walletId: number, index: number) {
    return await dbContext.wallets.update(walletId, {
      "settings.defaultChangeIndex": index
    });
  }

  public async updateUsedAddressFilter(walletId: number, hide: boolean) {
    return await dbContext.wallets.update(walletId, {
      "settings.hideUsedAddresses": hide
    });
  }

  public async getAll(): Promise<IDbWallet[]> {
    return await dbContext.wallets.toArray();
  }

  public async delete(walletId: number): Promise<void> {
    await Promise.all([
      dbContext.addresses.where({ walletId }).delete(),
      dbContext.assets.where({ walletId }).delete(),
      dbContext.connectedDApps.where({ walletId }).delete(),
      dbContext.utxos.where({ walletId }).delete(),
      dbContext.wallets.delete(walletId)
    ]);
  }
}

export const walletsDbService = new WalletsDbService();
