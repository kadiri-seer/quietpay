// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity 0.8.23;

interface IERC20Pool {
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
  function transfer(address to, uint256 amount) external returns (bool);
  function approve(address spender, uint256 amount) external returns (bool);
  function allowance(address owner, address spender) external view returns (uint256);
  function balanceOf(address account) external view returns (uint256);
}

interface IEntrypointMin {
  function deposit(address asset, uint256 value, uint256 precommitment) external returns (uint256 commitment);
}

/// @dev The parts of the 0xbow Privacy Pool this router uses. Struct layouts match
///   IPrivacyPool.Withdrawal and ProofLib.WithdrawProof / ProofLib.RagequitProof.
interface IPrivacyPoolMin {
  struct Withdrawal {
    address processooor;
    bytes data;
  }

  struct WithdrawProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[8] pubSignals;
  }

  struct RagequitProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[4] pubSignals;
  }

  function ASSET() external view returns (address);
  function ENTRYPOINT() external view returns (address);
  function SCOPE() external view returns (uint256);
  function nonce() external view returns (uint256);
  function depositors(uint256 label) external view returns (address);
  function withdraw(Withdrawal calldata withdrawal, WithdrawProof calldata proof) external;
  function ragequit(RagequitProof calldata proof) external;
}

/// @title QuietPay Pool Router
/// @notice Pays straight into the Privacy Pool for someone else. The payer supplies the
///   recipient's precommitment (a hash of secrets only the recipient knows), so only the recipient
///   can ever withdraw. The router is the pool depositor, which lets it give every deposit a
///   refund address chosen by the recipient: if the pool's approver never approves a deposit, the
///   recipient's ragequit proof returns it to that address, and to no other.
///
///   It also moves money from one pool note to a new note for another person in one
///   transaction (`transfer`), so it never sits in a public wallet in between.
///
/// @dev No owner, no admin functions, no upgrade path; it never holds funds between calls. The
///   pool and token are written once in the constructor, keeping the runtime bytecode identical
///   across deployments so clients can verify it by code hash.
contract QuietPayPoolRouter {
  /// @notice The Privacy Pool this router deposits into.
  address public pool;
  /// @notice The pool's entrypoint (deposits go through it).
  address public entrypoint;
  /// @notice The pool's asset; the only token this router moves.
  address public token;
  /// @notice The pool's scope (used to work out each deposit's label).
  uint256 public scope;
  /// @notice Where each deposit made through this router can be ragequit to, by deposit label.
  ///   Keyed by label (not commitment) so it also covers a deposit's later change notes.
  mapping(uint256 label => address refund) public refundTo;

  uint256 private _lock = 1;
  uint256 private constant SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

  /// @notice A payment into the pool. `amount` is before the pool's vetting fee.
  event Paid(address indexed payer, uint256 indexed label, uint256 commitment, uint256 precommitment, uint256 amount, address refund);
  /// @notice Money moved from one pool note into a new note, through `transfer`.
  event Transferred(uint256 indexed label, uint256 commitment, uint256 precommitment, uint256 amount, uint256 fee, address refund);
  /// @notice An unapproved deposit returned to its refund address.
  event Refunded(uint256 indexed label, address indexed refund, uint256 amount);

  error ZeroAddress();
  error NotAContract();
  error WrongPool();
  error ZeroAmount();
  error ZeroPrecommitment();
  error TokenTransferFailed();
  error AmountMismatch();
  error UnknownDeposit();
  error FeeTooLarge();
  error Reentrancy();
  error LabelMismatch();

  constructor(address pool_) {
    if (pool_ == address(0)) revert ZeroAddress();
    if (pool_.code.length == 0) revert NotAContract();
    address ep = IPrivacyPoolMin(pool_).ENTRYPOINT();
    address asset = IPrivacyPoolMin(pool_).ASSET();
    if (ep.code.length == 0 || asset.code.length == 0) revert WrongPool();
    pool = pool_;
    entrypoint = ep;
    token = asset;
    scope = IPrivacyPoolMin(pool_).SCOPE();
  }

  modifier nonReentrant() {
    if (_lock != 1) revert Reentrancy();
    _lock = 2;
    _;
    _lock = 1;
  }

  /// @notice Pays `amount` of the pool asset from the caller into the pool, under `precommitment`.
  /// @param refund The recipient's address for a refund if the deposit is never approved.
  /// @dev The entrypoint rejects a precommitment that was used before, so a one-time link can only
  ///   be paid once.
  function pay(uint256 precommitment, uint256 amount, address refund) external nonReentrant returns (uint256 label) {
    if (amount == 0) revert ZeroAmount();
    address t = token;
    uint256 before = _balance(t);
    _call(t, abi.encodeCall(IERC20Pool.transferFrom, (msg.sender, address(this), amount)));
    if (_balance(t) - before != amount) revert AmountMismatch();
    uint256 commitment;
    (label, commitment) = _deposit(t, amount, precommitment, refund);
    emit Paid(msg.sender, label, commitment, precommitment, amount, refund);
  }

  /// @notice Withdraws from a pool note and deposits the result under a new precommitment, in
  ///   one transaction. Anyone may submit it: every parameter is bound by the withdrawal proof.
  /// @dev `withdrawal.data` is abi.encode(newPrecommitment, refund, feeRecipient, fee). The pool
  ///   checks that the proof's context commits to the whole `withdrawal`, so none of these can be
  ///   changed by whoever submits it.
  function transfer(
    IPrivacyPoolMin.Withdrawal calldata withdrawal,
    IPrivacyPoolMin.WithdrawProof calldata proof
  ) external nonReentrant returns (uint256 label) {
    (uint256 precommitment, address refund, address feeRecipient, uint256 fee) =
      abi.decode(withdrawal.data, (uint256, address, address, uint256));
    address t = token;
    uint256 before = _balance(t);
    IPrivacyPoolMin(pool).withdraw(withdrawal, proof);
    uint256 got = _balance(t) - before;
    if (got != proof.pubSignals[2]) revert AmountMismatch();
    if (fee >= got) revert FeeTooLarge();
    if (fee != 0) {
      if (feeRecipient == address(0)) revert ZeroAddress();
      _call(t, abi.encodeCall(IERC20Pool.transfer, (feeRecipient, fee)));
    }
    uint256 commitment;
    (label, commitment) = _deposit(t, got - fee, precommitment, refund);
    emit Transferred(label, commitment, precommitment, got - fee, fee, refund);
  }

  /// @notice Returns an unapproved deposit made through this router to its refund address.
  ///   Anyone may submit it; the proof can only be made by whoever holds the deposit's secrets,
  ///   and the money can only go to the refund address recorded at deposit time.
  function ragequit(IPrivacyPoolMin.RagequitProof calldata proof) external nonReentrant {
    uint256 label = proof.pubSignals[3];
    address refund = refundTo[label];
    if (refund == address(0)) revert UnknownDeposit();
    address t = token;
    uint256 before = _balance(t);
    IPrivacyPoolMin(pool).ragequit(proof);
    uint256 got = _balance(t) - before;
    if (got != proof.pubSignals[2]) revert AmountMismatch();
    _call(t, abi.encodeCall(IERC20Pool.transfer, (refund, got)));
    emit Refunded(label, refund, got);
  }

  function _deposit(address t, uint256 amount, uint256 precommitment, address refund) private returns (uint256 label, uint256 commitment) {
    if (precommitment == 0) revert ZeroPrecommitment();
    if (refund == address(0)) revert ZeroAddress();
    address ep = entrypoint;
    _call(t, abi.encodeCall(IERC20Pool.approve, (ep, amount)));
    address p = pool;
    // The label the pool will give this deposit (PrivacyPool.deposit: keccak(SCOPE, ++nonce) mod field).
    label = uint256(keccak256(abi.encodePacked(scope, IPrivacyPoolMin(p).nonce() + 1))) % SNARK_SCALAR_FIELD;
    uint256 before = _balance(t);
    commitment = IEntrypointMin(ep).deposit(t, amount, precommitment);
    if (IPrivacyPoolMin(p).depositors(label) != address(this)) revert LabelMismatch();
    // The entrypoint must have taken exactly `amount`, leaving nothing approved or held here.
    if (before - _balance(t) != amount || IERC20Pool(t).allowance(address(this), ep) != 0) revert AmountMismatch();
    refundTo[label] = refund;
  }

  function _balance(address t) private view returns (uint256) {
    return IERC20Pool(t).balanceOf(address(this));
  }

  /// @dev Tolerates tokens that return no value; rejects ones that return false or revert.
  function _call(address t, bytes memory data) private {
    (bool ok, bytes memory ret) = t.call(data);
    if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TokenTransferFailed();
  }
}
