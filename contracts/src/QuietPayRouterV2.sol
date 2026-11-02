// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity 0.8.23;

interface IERC20Min {
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
  function balanceOf(address account) external view returns (uint256);
}

interface IERC5564AnnouncerMin {
  function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external;
}

/// @title QuietPay Router v2
/// @notice Pays a one-time ERC-5564 stealth address in one atomic transaction: moves exactly
///   `amount` of the payment token from the payer to the stealth address, forwards any ETH sent as
///   the recipient's gas money, and posts the ERC-5564 announcement. If any step fails, nothing
///   happens.
///
///   Compared with v1, the token and announcer are fixed at deployment (no caller can point the
///   router at another token or announcer), the announcement must describe the transfer that
///   actually happened, and one-time payment links are enforced onchain: a request ID can be paid
///   through `payOnce` only once, whoever pays and however many payers race.
///
/// @dev No owner, no upgrade path, no admin functions, and it never holds funds between calls.
///   `token` and `announcer` are written once in the constructor and never again, which keeps the
///   runtime bytecode identical across deployments, so clients can verify it by its code hash and
///   then read both addresses.
contract QuietPayRouterV2 {
  /// @notice Upper bound on the ETH forwarded for the recipient's gas.
  uint256 public constant MAX_GAS_STIPEND = 0.001 ether;
  uint256 private constant SCHEME_ID = 1;
  /// @dev ERC-5564 metadata: view tag (1), selector (4), token (20), amount (32) = 57 bytes,
  ///   then QuietPay's "QP" magic + version (3) and the request ID (16) = 76 bytes.
  uint256 private constant META_LEN = 57;
  uint256 private constant META_ONCE_LEN = 76;
  bytes4 private constant TRANSFER_SELECTOR = 0xa9059cbb;
  bytes3 private constant QP_MAGIC = 0x515001;

  /// @notice The only token this router moves.
  address public token;
  /// @notice The only announcer this router announces through.
  address public announcer;
  /// @notice One-time request IDs that have been paid.
  mapping(bytes16 => bool) public paidOnce;

  uint256 private _lock = 1;

  error ZeroAddress();
  error NotAContract();
  error ZeroAmount();
  error StipendTooLarge();
  error BadEphemeralKey();
  error BadMetadata();
  error ZeroRequestId();
  error AlreadyPaid(bytes16 requestId);
  error TokenTransferFailed();
  error AmountMismatch();
  error StipendTransferFailed();
  error Reentrancy();

  constructor(address token_, address announcer_) {
    if (token_ == address(0) || announcer_ == address(0)) revert ZeroAddress();
    if (token_.code.length == 0 || announcer_.code.length == 0) revert NotAContract();
    token = token_;
    announcer = announcer_;
  }

  modifier nonReentrant() {
    if (_lock != 1) revert Reentrancy();
    _lock = 2;
    _;
    _lock = 1;
  }

  /// @notice Pays a reusable (any-amount) link. The metadata must be plain ERC-5564 metadata for
  ///   this exact transfer and carry no request ID.
  function pay(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes calldata metadata) external payable nonReentrant {
    if (metadata.length != META_LEN) revert BadMetadata();
    _checkTransferMetadata(metadata, amount);
    _pay(stealthAddress, amount, ephemeralPubKey, metadata);
  }

  /// @notice Pays a one-time link. Reverts if `requestId` was already paid through this router.
  ///   The metadata must describe this transfer and end with this request ID.
  function payOnce(
    bytes16 requestId,
    address stealthAddress,
    uint256 amount,
    bytes calldata ephemeralPubKey,
    bytes calldata metadata
  ) external payable nonReentrant {
    if (requestId == bytes16(0)) revert ZeroRequestId();
    if (paidOnce[requestId]) revert AlreadyPaid(requestId);
    if (metadata.length != META_ONCE_LEN) revert BadMetadata();
    _checkTransferMetadata(metadata, amount);
    if (bytes3(metadata[57:60]) != QP_MAGIC || bytes16(metadata[60:76]) != requestId) revert BadMetadata();
    paidOnce[requestId] = true;
    _pay(stealthAddress, amount, ephemeralPubKey, metadata);
  }

  function _checkTransferMetadata(bytes calldata metadata, uint256 amount) private view {
    if (bytes4(metadata[1:5]) != TRANSFER_SELECTOR) revert BadMetadata();
    if (address(bytes20(metadata[5:25])) != token) revert BadMetadata();
    if (uint256(bytes32(metadata[25:57])) != amount) revert BadMetadata();
  }

  function _pay(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes calldata metadata) private {
    if (stealthAddress == address(0)) revert ZeroAddress();
    if (amount == 0) revert ZeroAmount();
    if (msg.value > MAX_GAS_STIPEND) revert StipendTooLarge();
    // A compressed secp256k1 public key, as ERC-5564 scheme 1 announces.
    if (ephemeralPubKey.length != 33 || (ephemeralPubKey[0] != 0x02 && ephemeralPubKey[0] != 0x03)) revert BadEphemeralKey();

    address t = token;
    uint256 before = IERC20Min(t).balanceOf(stealthAddress);
    // Tolerates tokens that return no value; rejects ones that return false or revert.
    (bool ok, bytes memory ret) = t.call(abi.encodeCall(IERC20Min.transferFrom, (msg.sender, stealthAddress, amount)));
    if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TokenTransferFailed();
    // The one-time address must have received exactly `amount` (no fee-on-transfer surprises).
    if (IERC20Min(t).balanceOf(stealthAddress) - before != amount) revert AmountMismatch();

    if (msg.value != 0) {
      (bool sent, ) = stealthAddress.call{value: msg.value}("");
      if (!sent) revert StipendTransferFailed();
    }

    IERC5564AnnouncerMin(announcer).announce(SCHEME_ID, stealthAddress, ephemeralPubKey, metadata);
  }
}
