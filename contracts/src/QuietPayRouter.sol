// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

interface IERC20Like {
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC5564AnnouncerLike {
  function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external;
}

/// @title QuietPay Router
/// @notice Pays a one-time ERC-5564 stealth address in a single atomic transaction:
///   1. moves `amount` of `token` from the payer to the stealth address (needs an exact approval),
///   2. forwards any ETH sent with the call to the stealth address, so the recipient can pay the
///      gas to claim without topping the address up from a wallet linked to them,
///   3. emits the ERC-5564 announcement through `announcer`.
/// If any step fails, the whole payment reverts, so a payment can never land without its
/// announcement.
/// @dev Holds no funds, has no owner and no upgrade path. The token and announcer are chosen by the
/// caller; the QuietPay app only ever passes its allowlisted token and bytecode-verified announcer.
contract QuietPayRouter {
  /// @notice Upper bound on the ETH forwarded for the recipient's gas, to limit mistakes.
  uint256 public constant MAX_GAS_STIPEND = 0.001 ether;
  uint256 private constant SCHEME_ID = 1;

  uint256 private _lock = 1;

  error ZeroAddress();
  error ZeroAmount();
  error StipendTooLarge();
  error TokenTransferFailed();
  error StipendTransferFailed();
  error Reentrancy();

  function pay(
    address token,
    address announcer,
    address stealthAddress,
    uint256 amount,
    bytes calldata ephemeralPubKey,
    bytes calldata metadata
  ) external payable {
    if (_lock != 1) revert Reentrancy();
    _lock = 2;

    if (token == address(0) || announcer == address(0) || stealthAddress == address(0)) revert ZeroAddress();
    if (amount == 0) revert ZeroAmount();
    if (msg.value > MAX_GAS_STIPEND) revert StipendTooLarge();

    // Token transfer, tolerant of tokens that return no value.
    (bool ok, bytes memory ret) =
      token.call(abi.encodeCall(IERC20Like.transferFrom, (msg.sender, stealthAddress, amount)));
    if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenTransferFailed();

    if (msg.value != 0) {
      (bool sent,) = stealthAddress.call{value: msg.value}("");
      if (!sent) revert StipendTransferFailed();
    }

    IERC5564AnnouncerLike(announcer).announce(SCHEME_ID, stealthAddress, ephemeralPubKey, metadata);

    _lock = 1;
  }
}
