/**
 * @utexo/lightsdk-gateway — API gateway in front of the rgb-node-api service that
 * hosts per-user watch-only RGB wallets.
 */
export const GATEWAY_NAME = '@utexo/lightsdk-gateway';

export { loadConfig, ConfigError, type GatewayConfig } from './config.js';
export { openDb, migrate, schemaVersion, type GatewayDb } from './db.js';
export {
  createUser,
  findUserByToken,
  generateToken,
  hashToken,
  safeEqual,
  makeAuthHook,
  makeOperatorGuard,
  type CreatedUser,
  type PreHandler,
} from './auth.js';
export { UserQueues, QueueFullError, type UserQueuesOptions } from './queue.js';
export {
  makeIdempotencyHooks,
  requestHash,
  type IdempotencyHooks,
  type IdempotencyClaim,
} from './idempotency.js';
export { HttpError } from './errors.js';
export { buildServer, type BuildServerOptions, type RouteSchemaEntry } from './server.js';
export {
  findKeyMaterialFields,
  findKeyMaterialInValue,
  KEY_MATERIAL_FIELD_NAMES,
} from './schemas/scan.js';
export {
  recordOwnership,
  ownerOf,
  updateResourceState,
  filterOwned,
  OwnershipConflictError,
  type ResourceKind,
  type ResourceRecord,
} from './scoping.js';
export {
  WalletBackendError,
  type Balance,
  type CreateUtxosParams,
  type ReceiveData,
  type ReceiveRequest,
  type SendAssetBeginRequest,
  type UserXpubs,
  type WalletAsset,
  type WalletBackend,
  type WalletBtcBalance,
  type WalletHandle,
  type WalletBlockTime,
  type WalletIdentity,
  type WalletTransaction,
  type WalletTransfer,
  type WalletUnspent,
} from './wallets/backend.js';
export {
  RgbNodeApiWalletBackend,
  DEFAULT_WALLET_SERVICE_TIMEOUT_MS,
  type RgbNodeApiBackendOptions,
} from './wallets/rgbnodeapi.js';
export { WalletOpQueues } from './wallets/queue.js';
export { WalletPool, type WalletPoolOptions } from './wallets/pool.js';
export {
  WalletService,
  type ReceiveParams,
  type ReceiveResult,
  type WalletBalances,
} from './wallets/service.js';
export {
  OnchainService,
  addressToScriptHex,
  txidFromPsbt,
  type CompletedOp,
  type IntentAsset,
  type IntentRecipient,
  type IntentUtxos,
  type OnchainIntent,
  type OnchainOpKind,
  type PreparedOp,
  type PrepareCreateUtxosParams,
  type PrepareSendAssetParams,
  type PrepareSendBtcParams,
} from './wallets/prepare.js';
