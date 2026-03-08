import assert from "node:assert/strict";

import {
  normalizeMotifClarificationState,
  resolveMotifClarificationTurn,
  updateMotifClarificationState,
} from "../motif/clarificationLoop.js";

function run(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((err: any) => {
      console.error(`FAIL ${name}:`, err?.message || err);
      throw err;
    });
}

async function main() {
  await run("motif clarification should only track uncertain-question plans", () => {
    const empty = normalizeMotifClarificationState(null);
    const unchanged = updateMotifClarificationState({
      currentState: empty,
      plan: {
        question: "请选择保留哪条冲突关系",
        rationale: "motif_conflict:m_conflict",
        topMotifId: "m_conflict",
      },
      motifs: [],
    });
    assert.equal(unchanged.pending, undefined);

    const pending = updateMotifClarificationState({
      currentState: unchanged,
      plan: {
        question: "直接确认：你是说“午休缓冲”会直接限制“轻松节奏”吗？",
        rationale: "motif_uncertain:m_focus:direct",
        topMotifId: "m_focus",
        template: "direct",
      },
      motifs: [
        {
          id: "m_focus",
          motif_id: "m_focus",
          motif_type: "constraint",
          templateKey: "tmpl_focus",
          motifType: "pair",
          relation: "constraint",
          roles: { sources: ["c1"], target: "c2" },
          scope: "global",
          aliases: [],
          concept_bindings: ["c1", "c2"],
          conceptIds: ["c1", "c2"],
          anchorConceptId: "c2",
          title: "午休缓冲限制轻松节奏",
          description: "",
          confidence: 0.64,
          supportEdgeIds: [],
          supportNodeIds: [],
          status: "uncertain",
          novelty: "new",
          updatedAt: new Date().toISOString(),
          motif_type_id: "mt_local_pace",
        },
      ] as any,
    });
    assert.equal(pending.pending?.motif_id, "m_focus");
    assert.equal(pending.pending?.motif_type_id, "mt_local_pace");
  });

  await run("affirmative clarification should promote uncertain motif to active", () => {
    const state = {
      pending: {
        motif_id: "m_focus",
        motif_type_id: "mt_local_pace",
        motif_title: "午休缓冲限制轻松节奏",
        question: "直接确认：你是说“午休缓冲”会直接限制“轻松节奏”吗？",
        rationale: "motif_uncertain:m_focus:direct",
        template: "direct" as const,
        asked_at: new Date().toISOString(),
      },
      history: [],
    };
    const out = resolveMotifClarificationTurn({
      currentState: state,
      motifs: [
        {
          id: "m_focus",
          motif_id: "m_focus",
          motif_type: "constraint",
          templateKey: "tmpl_focus",
          motifType: "pair",
          relation: "constraint",
          roles: { sources: ["c1"], target: "c2" },
          scope: "global",
          aliases: [],
          concept_bindings: ["c1", "c2"],
          conceptIds: ["c1", "c2"],
          anchorConceptId: "c2",
          title: "午休缓冲限制轻松节奏",
          description: "",
          confidence: 0.64,
          supportEdgeIds: [],
          supportNodeIds: [],
          status: "uncertain",
          novelty: "new",
          updatedAt: new Date().toISOString(),
        },
      ] as any,
      userText: "是的，就是这个意思。",
    });
    assert.equal(out.state.pending, undefined);
    assert.equal(out.state.history.length, 1);
    assert.equal(out.motifs[0].status, "active");
    assert.equal(out.motifs[0].resolved, true);
    assert.ok(Number(out.motifs[0].confidence || 0) >= 0.8);
  });

  await run("negative clarification should reject the uncertain motif and keep a history trail", () => {
    const state = {
      pending: {
        motif_id: "m_focus",
        motif_type_id: "mt_local_pace",
        motif_title: "午休缓冲限制轻松节奏",
        question: "直接确认：你是说“午休缓冲”会直接限制“轻松节奏”吗？",
        rationale: "motif_uncertain:m_focus:direct",
        template: "direct" as const,
        asked_at: new Date().toISOString(),
      },
      history: [],
    };
    const out = resolveMotifClarificationTurn({
      currentState: state,
      motifs: [
        {
          id: "m_focus",
          motif_id: "m_focus",
          motif_type: "constraint",
          templateKey: "tmpl_focus",
          motifType: "pair",
          relation: "constraint",
          roles: { sources: ["c1"], target: "c2" },
          scope: "global",
          aliases: [],
          concept_bindings: ["c1", "c2"],
          conceptIds: ["c1", "c2"],
          anchorConceptId: "c2",
          title: "午休缓冲限制轻松节奏",
          description: "",
          confidence: 0.7,
          supportEdgeIds: [],
          supportNodeIds: [],
          status: "uncertain",
          novelty: "new",
          updatedAt: new Date().toISOString(),
        },
      ] as any,
      userText: "不是，我的意思不是这个因果关系。",
    });
    assert.equal(out.state.pending, undefined);
    assert.equal(out.state.history.length, 1);
    assert.equal(out.state.history[0]?.resolution, "rejected");
    assert.equal(out.motifs[0].status, "deprecated");
    assert.equal(out.motifs[0].statusReason, "user_rejected_clarification");
  });
}

main().catch((err) => {
  console.error("motif clarification regression failed");
  console.error(err);
  process.exit(1);
});
