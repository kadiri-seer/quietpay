// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity 0.8.23;

/// @dev The owner functions of 0xbow's Entrypoint (a UUPS proxy) this guardian may call.
interface IEntrypointAdmin {
  function updatePoolConfiguration(address asset, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS) external;
  function registerPool(address asset, address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS) external;
  function removePool(address asset) external;
  function windDownPool(address pool) external;
  function withdrawFees(address asset, address recipient) external;
  function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
  function grantRole(bytes32 role, address account) external;
  function revokeRole(bytes32 role, address account) external;
}

/// @title QuietPay Pool Guardian
/// @notice Holds the pool Entrypoint's owner role so that no single key can change the pool at
///   once. Every change that could affect users' money (fees, upgrades, roles, pools) is proposed
///   publicly, waits `delay`, and can be cancelled while it waits; anyone can then carry it out.
///   Users who disagree with a pending change have the whole delay to withdraw or ragequit.
///
///   - Fees have hard ceilings: the deposit (vetting) fee can never exceed MAX_VETTING_FEE_BPS and
///     the relay fee ceiling never exceeds MAX_RELAY_FEE_BPS, whatever the admin proposes.
///   - Winding a pool down is immediate (an emergency brake): it only stops new deposits; existing
///     notes can still be withdrawn and ragequit.
///   - Collecting the fees the Entrypoint has taken is immediate; it never touches the pool's
///     deposits, which the pool contract holds.
///   - `admin` can be any address, including a multisig. Changing the admin or the delay goes
///     through the same delay.
///
/// @dev No upgrade path. Only the selectors listed in `_checkCall` can be proposed.
contract QuietPayPoolGuardian {
  /// @notice Highest deposit (vetting) fee that can ever be set: 1%.
  uint256 public constant MAX_VETTING_FEE_BPS = 100;
  /// @notice Highest relay-fee ceiling that can ever be set: 5%.
  uint256 public constant MAX_RELAY_FEE_BPS = 500;
  uint256 public constant MIN_DELAY = 1 hours;
  uint256 public constant MAX_DELAY = 30 days;
  /// @notice A proposal not carried out within this long after it becomes ready expires.
  uint256 public constant GRACE_PERIOD = 14 days;

  /// @notice The Entrypoint this guardian owns.
  address public immutable entrypoint;
  /// @notice Who may propose, cancel and use the immediate controls.
  address public admin;
  /// @notice How long every proposal waits before it can be carried out.
  uint256 public delay;
  /// @notice Proposals by id. `eta` 0 means none (never proposed, carried out or cancelled).
  mapping(bytes32 id => Proposal) public proposals;
  uint256 public proposalCount;

  struct Proposal {
    address target;
    uint64 eta;
    bytes data;
  }

  event Proposed(bytes32 indexed id, address indexed target, bytes4 indexed selector, bytes data, uint256 eta);
  event Executed(bytes32 indexed id, address indexed target, bytes data);
  event Cancelled(bytes32 indexed id);
  event AdminChanged(address indexed previousAdmin, address indexed newAdmin);
  event DelayChanged(uint256 previousDelay, uint256 newDelay);
  event PoolWoundDown(address indexed pool);
  event FeesWithdrawn(address indexed asset, address indexed recipient);

  error NotAdmin();
  error NotSelf();
  error ZeroAddress();
  error BadDelay();
  error NotAllowed(bytes4 selector);
  error FeeTooHigh();
  error NotAContract();
  error UnknownProposal();
  error NotReady(uint256 eta);
  error Expired();
  error CallFailed(bytes reason);

  constructor(address entrypoint_, address admin_, uint256 delay_) {
    if (entrypoint_ == address(0) || admin_ == address(0)) revert ZeroAddress();
    if (entrypoint_.code.length == 0) revert NotAContract();
    if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert BadDelay();
    entrypoint = entrypoint_;
    admin = admin_;
    delay = delay_;
    emit AdminChanged(address(0), admin_);
    emit DelayChanged(0, delay_);
  }

  modifier onlyAdmin() {
    if (msg.sender != admin) revert NotAdmin();
    _;
  }

  modifier onlySelf() {
    if (msg.sender != address(this)) revert NotSelf();
    _;
  }

  /* ---------------- Delayed changes ---------------- */

  /// @notice Proposes a call to the Entrypoint (or to this guardian, for setAdmin / setDelay).
  ///   It can be carried out after `delay`, by anyone, unless the admin cancels it first.
  function propose(address target, bytes calldata data) external onlyAdmin returns (bytes32 id) {
    _checkCall(target, data);
    id = keccak256(abi.encode(block.chainid, address(this), proposalCount++, target, data));
    uint256 eta = block.timestamp + delay;
    proposals[id] = Proposal({target: target, eta: uint64(eta), data: data});
    emit Proposed(id, target, bytes4(data[0:4]), data, eta);
  }

  /// @notice Carries out a proposal whose delay has passed.
  function execute(bytes32 id) external payable {
    Proposal memory p = proposals[id];
    if (p.eta == 0) revert UnknownProposal();
    if (block.timestamp < p.eta) revert NotReady(p.eta);
    if (block.timestamp > p.eta + GRACE_PERIOD) revert Expired();
    delete proposals[id];
    (bool ok, bytes memory ret) = p.target.call{value: msg.value}(p.data);
    if (!ok) revert CallFailed(ret);
    emit Executed(id, p.target, p.data);
  }

  /// @notice Cancels a pending proposal.
  function cancel(bytes32 id) external onlyAdmin {
    if (proposals[id].eta == 0) revert UnknownProposal();
    delete proposals[id];
    emit Cancelled(id);
  }

  /// @notice Only through a proposal: hands the admin to someone else (a multisig, say).
  function setAdmin(address newAdmin) external onlySelf {
    if (newAdmin == address(0)) revert ZeroAddress();
    emit AdminChanged(admin, newAdmin);
    admin = newAdmin;
  }

  /// @notice Only through a proposal: changes the delay, within MIN_DELAY..MAX_DELAY.
  function setDelay(uint256 newDelay) external onlySelf {
    if (newDelay < MIN_DELAY || newDelay > MAX_DELAY) revert BadDelay();
    emit DelayChanged(delay, newDelay);
    delay = newDelay;
  }

  /* ---------------- Immediate controls ---------------- */

  /// @notice Emergency brake: stops new deposits into `pool`. Withdrawals and ragequits keep working.
  function windDownPool(address pool) external onlyAdmin {
    IEntrypointAdmin(entrypoint).windDownPool(pool);
    emit PoolWoundDown(pool);
  }

  /// @notice Collects the deposit fees the Entrypoint holds. Users' deposits are in the pool, not here.
  function withdrawFees(address asset, address recipient) external onlyAdmin {
    if (recipient == address(0)) revert ZeroAddress();
    IEntrypointAdmin(entrypoint).withdrawFees(asset, recipient);
    emit FeesWithdrawn(asset, recipient);
  }

  /* ---------------- Rules ---------------- */

  /// @dev Only these calls can be proposed, and fee changes must stay under the ceilings.
  function _checkCall(address target, bytes calldata data) private view {
    if (data.length < 4) revert NotAllowed(bytes4(0));
    bytes4 sel = bytes4(data[0:4]);
    if (target == address(this)) {
      if (sel != this.setAdmin.selector && sel != this.setDelay.selector) revert NotAllowed(sel);
      return;
    }
    if (target != entrypoint) revert NotAllowed(sel);
    if (sel == IEntrypointAdmin.updatePoolConfiguration.selector) {
      (, , uint256 vetting, uint256 relay) = abi.decode(data[4:], (address, uint256, uint256, uint256));
      if (vetting > MAX_VETTING_FEE_BPS || relay > MAX_RELAY_FEE_BPS) revert FeeTooHigh();
    } else if (sel == IEntrypointAdmin.registerPool.selector) {
      (, , , uint256 vetting, uint256 relay) = abi.decode(data[4:], (address, address, uint256, uint256, uint256));
      if (vetting > MAX_VETTING_FEE_BPS || relay > MAX_RELAY_FEE_BPS) revert FeeTooHigh();
    } else if (sel == IEntrypointAdmin.upgradeToAndCall.selector) {
      (address impl, ) = abi.decode(data[4:], (address, bytes));
      if (impl.code.length == 0) revert NotAContract();
    } else if (sel == IEntrypointAdmin.grantRole.selector || sel == IEntrypointAdmin.revokeRole.selector) {
      // Roles: owner, default admin and postman. Granting the owner role to anyone else would
      // bypass this guardian, so it is allowed only through the same delay as everything else.
    } else if (sel != IEntrypointAdmin.removePool.selector) {
      revert NotAllowed(sel);
    }
  }
}
