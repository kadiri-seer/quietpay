// SPDX-License-Identifier: AGPL-3.0-or-later
// Hostile contracts used only by tests (tests/e2e-router-v2.test.ts). Never deployed.

pragma solidity 0.8.23;

interface IRouterV2 {
  function pay(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes calldata metadata) external payable;
  function payOnce(bytes16 requestId, address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes calldata metadata) external payable;
}

/// Minimal ERC-20 whose behaviour can be switched to misbehave in specific ways.
contract MockToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  event Transfer(address indexed from, address indexed to, uint256 value);

  // 0 normal, 1 return false, 2 no return value, 3 skim 1% fee, 4 credit nothing, 5 re-enter router
  uint8 public mode;
  address public reenterTarget;
  bytes public reenterCall;

  function setMode(uint8 m) external { mode = m; }
  function setReenter(address target, bytes calldata data) external { reenterTarget = target; reenterCall = data; }
  function mint(address to, uint256 amount) external { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
  function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
  function decimals() external pure returns (uint8) { return 6; }
  function symbol() external pure returns (string memory) { return "tUSDG"; }
  function name() external pure returns (string memory) { return "Mock"; }

  fallback() external {
    // transferFrom(address,address,uint256) with selectable misbehaviour.
    require(msg.sig == 0x23b872dd, "unknown");
    (address from, address to, uint256 amount) = abi.decode(msg.data[4:], (address, address, uint256));
    if (mode == 1) assembly { mstore(0, 0) return(0, 32) }
    require(allowance[from][msg.sender] >= amount, "allowance");
    allowance[from][msg.sender] -= amount;
    balanceOf[from] -= amount;
    if (mode == 3) {
      uint256 fee = amount / 100;
      balanceOf[to] += amount - fee;
    } else if (mode != 4) {
      balanceOf[to] += amount;
    }
    emit Transfer(from, to, amount);
    if (mode == 5) {
      (bool ok, bytes memory err) = reenterTarget.call(reenterCall);
      if (!ok) assembly { revert(add(err, 32), mload(err)) }
    }
    if (mode == 2) assembly { return(0, 0) }
    assembly { mstore(0, 1) return(0, 32) }
  }
}

/// A "one-time address" that refuses ETH.
contract RejectingReceiver {
  receive() external payable { revert("no ETH"); }
}

/// A "one-time address" that tries to pay again while receiving the gas money.
contract ReenteringReceiver {
  address public target;
  bytes public data;
  function set(address t, bytes calldata d) external { target = t; data = d; }
  receive() external payable {
    (bool ok, bytes memory err) = target.call(data);
    if (!ok) assembly { revert(add(err, 32), mload(err)) }
  }
}
