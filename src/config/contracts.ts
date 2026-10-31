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
