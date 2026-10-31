// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

/// @title QuietPay Test USDG (MOCK)
/// @notice A deliberately simple, worthless ERC-20 used ONLY on Robinhood Chain Testnet,
/// because no verified testnet USDG contract address was available. It is not USDG, is not
/// issued by Paxos, and must never be deployed or configured on mainnet.
/// @dev 6 decimals to mirror USDG. Anyone may mint up to `FAUCET_LIMIT` per call for testing.
contract QuietPayTestUSDG {
  string public constant name = "QuietPay Test USDG (MOCK)";
  string public constant symbol = "tUSDG";
  uint8 public constant decimals = 6;
  uint256 public constant FAUCET_LIMIT = 10_000 * 10 ** 6;

  uint256 public totalSupply;
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);

  error FaucetLimitExceeded();
  error InsufficientBalance();
  error InsufficientAllowance();
  error ZeroAddress();

  /// @notice Mint test tokens to the caller. Testnet only.
  function faucet(uint256 amount) external {
    if (amount > FAUCET_LIMIT) revert FaucetLimitExceeded();
    totalSupply += amount;
    balanceOf[msg.sender] += amount;
    emit Transfer(address(0), msg.sender, amount);
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _transfer(msg.sender, to, amount);
    return true;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    if (spender == address(0)) revert ZeroAddress();
    allowance[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 allowed = allowance[from][msg.sender];
    if (allowed != type(uint256).max) {
      if (allowed < amount) revert InsufficientAllowance();
      allowance[from][msg.sender] = allowed - amount;
    }
    _transfer(from, to, amount);
    return true;
  }

  function _transfer(address from, address to, uint256 amount) internal {
    if (to == address(0)) revert ZeroAddress();
    uint256 bal = balanceOf[from];
    if (bal < amount) revert InsufficientBalance();
    unchecked {
      balanceOf[from] = bal - amount;
    }
    balanceOf[to] += amount;
    emit Transfer(from, to, amount);
  }
}
