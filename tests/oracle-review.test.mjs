import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {parseTrailers, proposalRecordSha256, receiptSha256, stampCommitMessage, validateOracleResponse, verifyCommitMessage, verifyProposalRecord, verifyPublishedCommitTrailers, verifyReceipt} from "../scripts/oracle-review.mjs";

function approvedReceipt(tree = "1".repeat(40)) {
  const receipt = {
    schema: "my-crm.oracle-approval/v1",
    repository: "my-crm",
    reviewed_tree: tree,
    base_commit: "2".repeat(40),
    verdict: "APPROVED",
    authentication_impact: false,
    owner_approval_status: "NOT_REQUIRED",
    validation_evidence: ["npm test: 64 passed"],
    owner_approval_evidence: null,
    warning: null,
    summary: "Candidate conforms.",
    findings: []
  };
  receipt.receipt_sha256 = receiptSha256(receipt);
  return receipt;
}

test("Oracle receipt is bound to the exact staged Git tree", () => {
  const receipt = approvedReceipt();
  assert.equal(verifyReceipt(receipt, receipt.reviewed_tree), receipt);
  assert.throws(() => verifyReceipt(receipt, "3".repeat(40)), /stale/);
  assert.throws(() => verifyReceipt({...receipt, summary: "changed"}, receipt.reviewed_tree), /digest/);
  assert.throws(() => verifyReceipt({...receipt, verdict: "REJECTED", receipt_sha256: receiptSha256({...receipt, verdict: "REJECTED"})}, receipt.reviewed_tree), /verdict/);
});

test("proposal records are separate, base-bound, and must be approved", () => {
  const record = {
    schema: "my-crm.oracle-proposal/v1", repository: "my-crm",
    base_commit: "2".repeat(40), proposal: "restore behavior",
    proposal_sha256: "3".repeat(64), validation_evidence: [],
    owner_approval_evidence: null,
    review: {verdict: "APPROVED", authentication_impact: false, owner_approval_status: "NOT_REQUIRED"},
  };
  record.record_sha256 = proposalRecordSha256(record);
  assert.equal(verifyProposalRecord(record, record.base_commit), record);
  assert.throws(() => verifyProposalRecord({...record, base_commit: "4".repeat(40)}, record.base_commit), /base commit/);
  const rejected = {...record, review: {...record.review, verdict: "REJECTED"}};
  rejected.record_sha256 = proposalRecordSha256(rejected);
  assert.throws(() => verifyProposalRecord(rejected, rejected.base_commit), /approved Oracle proposal/);
});

test("Oracle utility owns exact commit trailers", () => {
  const receipt = approvedReceipt();
  const message = stampCommitMessage("feat: candidate\n", receipt);
  const trailers = parseTrailers(message);
  assert.equal(trailers["Oracle-Verdict"], "APPROVED");
  assert.equal(trailers["Oracle-Reviewed-Tree"], receipt.reviewed_tree);
  assert.equal(trailers["Oracle-Receipt-SHA256"], receipt.receipt_sha256);
  assert.doesNotThrow(() => verifyCommitMessage({message, tree: receipt.reviewed_tree, receipt}));
  assert.throws(() => stampCommitMessage(message, receipt), /reserved/);
});

test("local commit verification rejects missing, stale, and trailer-only forged approvals", () => {
  const receipt = approvedReceipt();
  const message = stampCommitMessage("fix: candidate", receipt);
  assert.throws(() => verifyCommitMessage({message: "fix: candidate", tree: receipt.reviewed_tree}), /missing Oracle-Verdict/);
  assert.throws(() => verifyCommitMessage({message, tree: "4".repeat(40), receipt}), /does not match/);
  assert.throws(() => verifyCommitMessage({message, tree: receipt.reviewed_tree}), /receipt evidence is required/);
  const forged = {...receipt, summary: "forged", receipt_sha256: receiptSha256({...receipt, summary: "forged"})};
  const forgedMessage = stampCommitMessage("fix: forged", forged);
  assert.throws(() => verifyCommitMessage({message: forgedMessage, tree: forged.reviewed_tree, receipt}), /does not match the local Oracle receipt/);
});

test("published gate validates receipt-derived tree trailers under the trusted-agent boundary", () => {
  const receipt = approvedReceipt();
  const message = stampCommitMessage("fix: candidate", receipt);
  assert.doesNotThrow(() => verifyPublishedCommitTrailers({message, tree: receipt.reviewed_tree}));
  assert.throws(() => verifyPublishedCommitTrailers({message, tree: "5".repeat(40)}), /does not match/);
});

test("ordinary agents call an isolated Oracle utility and never impersonate the approver", async () => {
  const [agents, shipIt, oracleSkill, workflow, packageJson, oracleUtility] = await Promise.all([
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
    readFile(new URL("../.agents/skills/ship-it/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../.agents/skills/oracle/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../scripts/oracle-review.mjs", import.meta.url), "utf8")
  ]);
  assert.match(agents, /Oracle is an independent approval process/);
  assert.match(agents, /trust boundary is process separation/);
  assert.match(agents, /\/Users\/cody\/Development\/Projects\/tools\/projects_oracle\.py/);
  assert.doesNotMatch(agents, /\.\.\/\.agents\/skills\/oracle\/SKILL\.md/);
  assert.match(shipIt, /npm run oracle:review/);
  assert.match(shipIt, /shipping agent never classifies authentication impact/);
  assert.doesNotMatch(shipIt, /Read .*\.agents\/skills\/oracle\/SKILL\.md/);
  assert.equal(packageJson.scripts["oracle:review"], "node scripts/oracle-review.mjs review");
  assert.equal(packageJson.scripts["oracle:proposal"], "node scripts/oracle-review.mjs proposal");
  assert.match(workflow, /npm run oracle:verify-commit/);
  assert.match(workflow, /fetch-depth: 2/);
  assert.match(oracleUtility, /"--ignore-user-config"/);
  assert.match(oracleUtility, /architecture and public API-contract changes as protected changes/i);
  assert.match(oracleUtility, /Problem, Cause, Recommended change/i);
  assert.match(oracleUtility, /no more than three sentences in each part/i);
  assert.match(oracleUtility, /Never convert an Oracle recommendation into an approved target/i);
  assert.match(shipIt, /architecture/i);
  assert.match(shipIt, /public API-contract/i);
  assert.match(shipIt, /authentication/i);
  assert.match(shipIt, /authorization/i);
  assert.match(shipIt, /Problem[\s\S]*Cause[\s\S]*Recommended[\s\S]*change/i);
  assert.match(shipIt, /three[\s\S]{0,20}sentences/i);
  assert.match(oracleSkill, /\/Users\/cody\/Development\/Projects\/tools\/projects_oracle\.py/);
  assert.doesNotMatch(oracleSkill, /\.\.\/\.agents\/skills\/oracle\/SKILL\.md/);
});

test("Oracle alone classifies authentication impact and owner-approval sufficiency", () => {
  assert.doesNotThrow(() => validateOracleResponse({verdict: "APPROVED", authentication_impact: false, owner_approval_status: "NOT_REQUIRED"}));
  assert.doesNotThrow(() => validateOracleResponse({verdict: "APPROVED", authentication_impact: true, owner_approval_status: "APPROVED"}));
  assert.doesNotThrow(() => validateOracleResponse({verdict: "REJECTED", authentication_impact: true, owner_approval_status: "MISSING"}));
  assert.throws(() => validateOracleResponse({verdict: "APPROVED", authentication_impact: true, owner_approval_status: "MISSING"}), /requires owner_approval_status APPROVED/);
  assert.throws(() => validateOracleResponse({verdict: "REJECTED", authentication_impact: true, owner_approval_status: "NOT_REQUIRED"}), /cannot mark owner approval NOT_REQUIRED/);
  assert.throws(() => validateOracleResponse({verdict: "APPROVED", authentication_impact: false, owner_approval_status: "APPROVED"}), /must mark owner approval NOT_REQUIRED/);
});
