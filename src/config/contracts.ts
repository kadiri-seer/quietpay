/**
 * Contract ABIs and known bytecode fingerprints.
 *
 * KNOWN_ANNOUNCER_CODE_HASHES must match contracts/artifacts/ERC5564Announcer.json
 * (`runtimeCodeHash`). A unit test enforces this. The app refuses to use an announcer whose
 * deployed runtime bytecode does not hash to one of these values, so a misconfigured or
 * malicious address cannot silently swallow announcements.
 */

export const ERC5564_SCHEME_ID = 1n;

export const KNOWN_ANNOUNCER_CODE_HASHES: readonly `0x${string}`[] = [
  // QuietPay build of ScopeLift ERC5564Announcer, solc 0.8.23, optimizer 200, evm paris.
  "0x0af95fb5a29fc215ce3b805393c1f7c0530999f793faeb08f8bae6dd110797c0",
];

/**
 * QuietPayRouter v1 build. RETIRED: the app never pays through it (it didn't check that the
 * announcement matched the transfer). Kept only so a misconfigured v1 address is recognised and
 * refused with a clear message.
 */
export const RETIRED_ROUTER_V1_CODE_HASHES: readonly `0x${string}`[] = [
  "0xc651ba2cdd6e69e0ff3048a9d2291633ec1476301cc964ea563bdb494066483d",
];

/**
 * QuietPayRouterV2 build. Its token and announcer are stored once in the constructor (not as
 * immutables), so the runtime code hash is the same for every deployment; clients check the hash,
 * then read token() and announcer() and compare them with their own configuration.
 */
export const KNOWN_ROUTER_V2_CODE_HASHES: readonly `0x${string}`[] = [
  "0x4a156d5db51b4115a9d541c8ac43e30367b362787feae7a72bbeed05e860f434",
];

/** QuietPayRouterV3: v2 plus onchain destination checks (same ABI, same token/announcer binding). */
export const KNOWN_ROUTER_V3_CODE_HASHES: readonly `0x${string}`[] = [
  "0x7204fbccf48311a25c51fc39827c319a9f331142c457464a4589b21d574d6e3b",
];

export const routerV2Abi = [
  {
    type: "function",
    name: "pay",
    stateMutability: "payable",
    inputs: [
      { name: "stealthAddress", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "ephemeralPubKey", type: "bytes" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "payOnce",
    stateMutability: "payable",
    inputs: [
      { name: "requestId", type: "bytes16" },
      { name: "stealthAddress", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "ephemeralPubKey", type: "bytes" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "announcer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paidOnce", stateMutability: "view", inputs: [{ name: "requestId", type: "bytes16" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "MAX_GAS_STIPEND", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "error", name: "AlreadyPaid", inputs: [{ name: "requestId", type: "bytes16" }] },
  { type: "error", name: "BadDestination", inputs: [] },
] as const;

/** QuietPayRouter v1 ABI. Retired: only tests of the old contract use it. */
export const routerAbi = [
  {
    type: "function",
    name: "pay",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "announcer", type: "address" },
      { name: "stealthAddress", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "ephemeralPubKey", type: "bytes" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "MAX_GAS_STIPEND", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const MOCK_TOKEN_CODE_HASH =
  "0x7ed2078db1dc7dec7ac49172e597f9d7bee15356908dc6160cd03e72fa7d052c" as const;

export const announcerAbi = [
  {
    type: "event",
    name: "Announcement",
    inputs: [
      { name: "schemeId", type: "uint256", indexed: true },
      { name: "stealthAddress", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "ephemeralPubKey", type: "bytes", indexed: false },
      { name: "metadata", type: "bytes", indexed: false },
    ],
  },
  {
    type: "function",
    name: "announce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schemeId", type: "uint256" },
      { name: "stealthAddress", type: "address" },
      { name: "ephemeralPubKey", type: "bytes" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export const mockTokenFaucetAbi = [
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;
