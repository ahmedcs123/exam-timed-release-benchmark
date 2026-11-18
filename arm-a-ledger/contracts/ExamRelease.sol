// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

/// @title ExamRelease — Arm A of the exam timed-release benchmark.
/// @notice Same rules as the Arm B coordinator: no share before T0, a share must match the
/// commitment registered at setup, only the assigned trustee account may submit it, and the
/// first valid share per index is final. Centres read the shares straight from the chain.
/// @dev Commitment = SHA-256("commit:" || examId || ":" || index (decimal) || ":" || share),
/// identical to commitShare() in shared/src/shares.js.
contract ExamRelease {
    struct Exam {
        uint64 t0;          // release time, unix seconds (block.timestamp)
        uint8 k;
        uint8 n;
        uint8 submitted;
        address registrar;
        bool exists;
    }

    mapping(bytes32 => Exam) public exams;
    mapping(bytes32 => mapping(uint8 => address)) public trusteeOf;
    mapping(bytes32 => mapping(uint8 => bytes32)) public commitmentOf;
    mapping(bytes32 => mapping(uint8 => bytes)) private shareOf;

    event ExamRegistered(bytes32 indexed examKey, string examId, uint64 t0, uint8 k, uint8 n);
    event ShareSubmitted(bytes32 indexed examKey, uint8 indexed index, address trustee, uint64 blockTime);

    error ExamExists();
    error UnknownExam();
    error BadParams();
    error TooEarly(uint64 blockTime, uint64 t0);
    error NotTrustee();
    error AlreadySubmitted();
    error BadCommitment();

    function examKey(string calldata examId) public pure returns (bytes32) {
        return keccak256(bytes(examId));
    }

    function registerExam(
        string calldata examId,
        uint64 t0,
        uint8 k,
        address[] calldata trustees,
        bytes32[] calldata commitments
    ) external {
        bytes32 key = examKey(examId);
        if (exams[key].exists) revert ExamExists();
        uint256 n = trustees.length;
        if (k < 2 || n < k || n > 255 || commitments.length != n) revert BadParams();
        exams[key] = Exam({t0: t0, k: k, n: uint8(n), submitted: 0, registrar: msg.sender, exists: true});
        for (uint8 i = 0; i < n; i++) {
            trusteeOf[key][i] = trustees[i];
            commitmentOf[key][i] = commitments[i];
        }
        emit ExamRegistered(key, examId, t0, k, uint8(n));
    }

    function submitShare(string calldata examId, uint8 index, bytes calldata share) external {
        bytes32 key = examKey(examId);
        Exam storage e = exams[key];
        if (!e.exists) revert UnknownExam();
        if (block.timestamp < e.t0) revert TooEarly(uint64(block.timestamp), e.t0);
        if (index >= e.n || trusteeOf[key][index] != msg.sender) revert NotTrustee();
        if (shareOf[key][index].length != 0) revert AlreadySubmitted();
        bytes32 c = sha256(abi.encodePacked("commit:", examId, ":", _dec(index), ":", share));
        if (c != commitmentOf[key][index]) revert BadCommitment();
        shareOf[key][index] = share;
        e.submitted += 1;
        emit ShareSubmitted(key, index, msg.sender, uint64(block.timestamp));
    }

    /// @notice All submitted shares (index + bytes). Centres call this on any node.
    function getShares(string calldata examId) external view returns (uint8[] memory idx, bytes[] memory shares) {
        bytes32 key = examKey(examId);
        Exam storage e = exams[key];
        if (!e.exists) revert UnknownExam();
        idx = new uint8[](e.submitted);
        shares = new bytes[](e.submitted);
        uint256 j = 0;
        for (uint8 i = 0; i < e.n && j < e.submitted; i++) {
            if (shareOf[key][i].length != 0) {
                idx[j] = i;
                shares[j] = shareOf[key][i];
                j++;
            }
        }
    }

    function _dec(uint8 v) private pure returns (bytes memory) {
        if (v >= 100) return abi.encodePacked(bytes1(uint8(48 + v / 100)), bytes1(uint8(48 + (v / 10) % 10)), bytes1(uint8(48 + v % 10)));
        if (v >= 10) return abi.encodePacked(bytes1(uint8(48 + v / 10)), bytes1(uint8(48 + v % 10)));
        return abi.encodePacked(bytes1(uint8(48 + v)));
    }
}
