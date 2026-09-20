// Needs classifier (spec 0.1.3; extended 2026-09-19 per the
// router-as-orchestrator SPEC §1.1-§1.2). ONE askSystemOne call. The original
// TWO choice questions (capability tier + effort score) are byte-stable (the
// tier eval `tier-eval.ts` measures them); the router-as-orchestrator wave
// adds placement/target/steer_wait/chain questions to the SAME request — one
// HTTP call, one latency budget (intent decision 26: NEVER sequential asks).
// Never throws - any failure fails open to undefined. Criteria ride the
// structured {what, not_for, examples} shape (TypeSafeCriterionDetail - the
// form measured at 86% agreement on the code/general judge). Egress caps are
// enforced here defensively: the turn text to state_max_chars, topic
// name+description to topic_max_chars (original default 300); the context
// digest cap (2000) is enforced upstream by router.ts/context-reader.ts.

import type { CapabilityTier, EffortScore } from '../../types.js';
import { askSystemOne } from '../typesafe-client.js';
import type { TypeSafeRequest, TypeSafeResult, AskOptions } from '../typesafe-client.js';

export interface NeedsProfile {
  tier: CapabilityTier;
  score: EffortScore;
  confidence: number;
}

export const TIER_VALUES: CapabilityTier[] = ['quick_lookup', 'standard', 'deep_reasoning', 'rich_toolchain'];
export const SCORE_VALUES: EffortScore[] = [1, 2, 3, 4, 5];

const VALID_TIERS = new Set<string>(TIER_VALUES);

const DEFAULT_TOPIC_MAX_CHARS = 300;

// §1.2 prompt-assembly caps (model_router.placement.*).
export const DEFAULT_GOAL_CHARS = 80;
export const DEFAULT_SECTION_CHARS = 2400;
const INFLIGHT_VIEW_MAX = 3;
const INFLIGHT_TITLE_CHARS = 60;
const STATUS_CHARS = 40;

// §1.1 placement choices, in ask order.
export const PLACEMENT_CHOICES = ['direct', 'current', 'other', 'new', 'split2', 'split3'] as const;
export type PlacementChoice = (typeof PLACEMENT_CHOICES)[number];
const VALID_PLACEMENT = new Set<string>(PLACEMENT_CHOICES);

/** One bounded candidate view passed in by the caller (built from the
 *  voice-inbox ledger reader; §3.1). ids/short goals only — no raw turn text. */
export interface PlacementCandidateView {
  id: string;            // candidate id ('vi-<12 hex>')
  goal: string;          // short goal (caller applies the ≤ goal_chars cap)
  status: string;        // newest task's state word
  inflight: boolean;
}

/** One in-flight run view (§4.1). id = 't-<n>' or 'topic'. */
export interface InflightRunView {
  id: string;            // 't-<n>' or 'topic'
  title: string;         // ≤60 chars
  status: string;        // e.g. 'running'
}

export interface ClassifiedTurnPlacement {
  choice: PlacementChoice;
  /** candidate ids and/or 'new' (§1.1). Empty for direct/current. */
  targets: string[];
  /** true when the prompt-assembly section cap dropped candidates tail-first */
  truncated?: boolean;
  /** true when a target answer was invalid and the placement downgraded —
   *  the router records shadow reason '<base>+invalid-target' for it
   *  (validation failure) */
  invalidTarget?: boolean;
  /** true when the placement QUESTION was asked but the CHOICE answer was
   *  absent or garbage (completeness failure — decision 17(c)
   *  measurability): the router records shadow reason
   *  '<base>+absent-placement'. Mutually exclusive with invalidTarget by
   *  construction (targets are only validated against a valid choice). */
  absentChoice?: boolean;
}

export interface ClassifiedTurn extends NeedsProfile {
  placement?: ClassifiedTurnPlacement;
  steerWait?: 'steer' | 'wait';
  /** worker -> probability, from the chain answer's probabilities map
   *  (decision 20). Absent = today's rank-order chain. */
  chainP?: Record<string, number>;
}

function capStr(v: string | undefined, max: number): string {
  if (!v) return '';
  return v.length > max ? v.slice(0, max) : v;
}

export async function classifyNeeds(input: {
  text: string;
  contextDigest: string;
  topic: { name?: string; description?: string };
  caps: { state_max_chars: number; topic_max_chars?: number };
  /** When present (even empty), adds the placement question (§1.1). */
  candidates?: PlacementCandidateView[];
  /** When non-empty, adds the steer_wait question (§1.1). */
  currentInflight?: InflightRunView[];
  /** Distinct table workers (config order); when present and non-empty,
   *  adds the chain question (§1.1). */
  chainWorkers?: string[];
  /** Prompt-assembly caps (§1.2); defaults 80/2400. */
  placement?: { goal_chars?: number; section_chars?: number };
  ask?: (req: TypeSafeRequest, opts: AskOptions) => Promise<TypeSafeResult>;
}): Promise<ClassifiedTurn | undefined> {
  try {
    const ask = input.ask ?? askSystemOne;
    const cappedText = input.text.length > input.caps.state_max_chars
      ? input.text.slice(0, input.caps.state_max_chars)
      : input.text;
    const topicMax =
      Number.isFinite(input.caps.topic_max_chars) && (input.caps.topic_max_chars ?? 0) > 0
        ? input.caps.topic_max_chars!
        : DEFAULT_TOPIC_MAX_CHARS;

    const goalChars =
      Number.isFinite(input.placement?.goal_chars) && (input.placement?.goal_chars ?? 0) > 0
        ? input.placement!.goal_chars!
        : DEFAULT_GOAL_CHARS;
    const sectionChars =
      Number.isFinite(input.placement?.section_chars) && (input.placement?.section_chars ?? 0) > 0
        ? input.placement!.section_chars!
        : DEFAULT_SECTION_CHARS;

    const hasCandidates = input.candidates !== undefined;
    const allCandidates = (input.candidates ?? []).map((c) => ({
      id: String(c.id),
      goal: capStr(c.goal, goalChars),
      status: capStr(c.status, STATUS_CHARS),
      inflight: !!c.inflight,
    }));
    // §1.2: the prompt-assembly section cap drops candidates TAIL-FIRST,
    // never splitting a goal mid-line; truncation is expected at the defaults
    // (25 × ~120 chars ≈ 3000 > 2400) and recorded (truncated -> the router's
    // shadow line).
    let truncated = false;
    let section = allCandidates;
    while (JSON.stringify(section).length > sectionChars && section.length > 0) {
      section = section.slice(0, -1);
      truncated = true;
    }
    const inflight = (input.currentInflight ?? []).slice(0, INFLIGHT_VIEW_MAX).map((r) => ({
      id: String(r.id),
      title: capStr(r.title, INFLIGHT_TITLE_CHARS),
      status: capStr(r.status, STATUS_CHARS),
    }));

    const request: TypeSafeRequest = {
      state: {
        text: cappedText,
        context_digest: input.contextDigest,
        topic_name: capStr(input.topic.name, topicMax),
        topic_description: capStr(input.topic.description, topicMax),
        ...(hasCandidates ? { candidates: section } : {}),
        ...(inflight.length > 0 ? { current_inflight: inflight } : {}),
      },
      questions: {
        tier: {
          type: 'choice',
          instructions:
            'Classify what this turn needs. quick_lookup = an instant factual lookup or trivial edit; ' +
            'standard = an ordinary single-file edit or question; deep_reasoning = multi-step analysis, ' +
            'design judgment or debugging; rich_toolchain = a long agentic task needing tool execution.',
          criteria: {
            quick_lookup: {
              what: 'an instant factual lookup or trivial edit answerable from the text alone',
              not_for: 'anything needing tool use or multi-step work',
              examples: ['one factual question', 'a one-word reply'],
            },
            standard: {
              what: 'an ordinary single-file edit or one-shot question',
              not_for:
                'multi-step analysis or tool loops; implementation/build/integrate/feature ' +
                'requests (e.g. "build X", "integrate Y", "add Z to...")',
              examples: ['fix a button label', 'summarize a doc'],
            },
            deep_reasoning: {
              what: 'multi-step analysis, design judgment, or debugging across files',
              not_for: 'single-step lookups or edits',
              examples: [
                'architecture trade-off',
                'root-cause across modules',
                'build a new UI component',
                'integrate an external API',
              ],
            },
            rich_toolchain: {
              what: 'a long agentic task needing build/test/terminal loops or many tools',
              not_for: 'prose-only answers',
              examples: ['implement+test a feature', 'run a migration'],
            },
          },
        },
        score: {
          type: 'choice',
          instructions:
            'How much reasoning effort does this turn need? 1 = trivial, 2 = simple, ' +
            '3 = ordinary, 4 = hard, 5 = hardest.',
          criteria: {
            '1': {
              what: 'a trivial lookup or one-word reply',
              not_for: 'anything needing real work',
              examples: ['what time is it in London', 'ok'],
            },
            '2': {
              what: 'a simple mechanical change',
              not_for: 'analysis or design judgment',
              examples: ['rename this variable', 'fix the typo'],
            },
            '3': {
              what: 'an ordinary task',
              not_for: 'trivial replies or deep multi-file work',
              examples: ['summarize this page', 'small one-file fix'],
            },
            '4': {
              what: 'hard work that needs care',
              not_for: 'simple or mechanical turns',
              examples: ['debug a failing test', 'refactor a module'],
            },
            '5': {
              what: 'the hardest class of task',
              not_for: 'anything bounded or single-step',
              examples: ['design a new subsystem', 'root-cause a production outage'],
            },
          },
        },
        ...(hasCandidates
          ? {
              placement: {
                type: 'choice' as const,
                instructions:
                  'Where should this turn be placed? default is same-place (direct/current) unless the request ' +
                  'clearly belongs to another conversation; split only for clearly separable, unrelated parts (2–3 max). ' +
                  'direct = answer here without a conversation; current = continue this conversation in place; ' +
                  'other = continue a DIFFERENT existing conversation (pick its id in `target`); ' +
                  'new = start a new conversation; split2/split3 = split across 2/3 targets (then and only then ' +
                  'fill `target`/`target2`/`target3`).',
                criteria: {
                  direct: {
                    what: 'a one-off question or task that belongs to no ongoing conversation',
                    not_for: 'continuing or starting tracked conversations',
                    examples: ['a quick factual question', 'a standalone command-like request'],
                  },
                  current: {
                    what: 'a continuation of the CURRENT conversation',
                    not_for: 'unrelated new work',
                    examples: ['a follow-up to the previous turn', 'a correction to the running task'],
                  },
                  other: {
                    what: 'a continuation of a DIFFERENT existing conversation listed in `candidates`',
                    not_for: 'same-place work or brand-new work',
                    examples: ['an update for another listed conversation'],
                  },
                  new: {
                    what: 'clearly NEW work that fits no listed conversation',
                    not_for: 'anything matching a listed candidate',
                    examples: ['a brand-new task unrelated to every candidate'],
                  },
                  split2: {
                    what: 'the message contains clearly separable, UNRELATED parts for exactly 2 targets',
                    not_for: 'single-topic messages (precision bias: default same-place)',
                    examples: ['two unrelated requests in one message'],
                  },
                  split3: {
                    what: 'the message contains clearly separable, UNRELATED parts for exactly 3 targets',
                    not_for: 'single-topic messages (precision bias: default same-place)',
                    examples: ['three unrelated requests in one message'],
                  },
                },
              },
            }
          : {}),
        ...(hasCandidates && section.length > 0
          ? {
              target: targetQuestion(section, 'The FIRST target of the placement (candidate id, or "new" when placement is `new`).'),
              target2: targetQuestion(section, 'The SECOND target (only meaningful when splitting; ignored otherwise).'),
              target3: targetQuestion(section, 'The THIRD target (only meaningful for split3; ignored otherwise).'),
            }
          : {}),
        ...((input.currentInflight ?? []).length > 0
          ? {
              steer_wait: {
                type: 'choice' as const,
                instructions:
                  'A run is IN FLIGHT in this conversation. steer = interrupt it and apply this turn as the ' +
                  'correction now; wait = queue this turn behind the in-flight run. Both errors are bounded.',
                criteria: {
                  steer: {
                    what: 'the new turn corrects or supersedes the in-flight work',
                    not_for: 'independent requests that can simply queue',
                    examples: ['a fix to the instruction just sent', 'the task changed direction'],
                  },
                  wait: {
                    what: 'the turn can wait its turn behind the running work',
                    not_for: 'corrections to what is running right now',
                    examples: ['an unrelated follow-up request'],
                  },
                },
              },
            }
          : {}),
        ...((input.chainWorkers ?? []).length > 0
          ? {
              chain: {
                type: 'choice' as const,
                instructions:
                  'Rank the dispatch-chain candidates for this turn: which worker should serve it first? ' +
                  'The answer is one worker; the per-option probabilities are the ranking payload.',
                criteria: Object.fromEntries(
                  (input.chainWorkers ?? []).map((w) => [
                    w,
                    {
                      what: `serve this turn on ${w}`,
                      not_for: undefined,
                      examples: [] as string[],
                    },
                  ])
                ),
              },
            }
          : {}),
      },
    };

    // Lenient parse (M1): a missing/out-of-options answer for ONE question is
    // marked absent instead of voiding the whole response — the fail-open
    // contract binds HERE, per question, and only tier/score failure fails
    // the classification.
    const result = await ask(request, { purpose: 'model-router', lenient: true });
    if (!result.ok) return undefined;
    const tierAns = result.answers.tier;
    const scoreAns = result.answers.score;
    if (!tierAns || tierAns.type !== 'choice' || !VALID_TIERS.has(tierAns.choice)) return undefined;
    if (!scoreAns || scoreAns.type !== 'choice') return undefined;
    const score = Number(scoreAns.choice);
    if (!SCORE_VALUES.includes(score as EffortScore)) return undefined;
    const confidence = Math.min(tierAns.confidence ?? 0, scoreAns.confidence ?? 0);

    const out: ClassifiedTurn = { tier: tierAns.choice as CapabilityTier, score: score as EffortScore, confidence };

    // Per-question fail-open validation (§1.1): a bad NEW answer never fails
    // the whole ask when tier/score succeeded — it degrades to today's
    // behavior (no placement, rank-order chain, no steer/wait).

    // placement (+ targets). Unknown placement choice -> no placement at all.
    const placeAns = result.answers.placement;
    if (hasCandidates && placeAns && placeAns.type === 'choice' && VALID_PLACEMENT.has(placeAns.choice)) {
      const choice = placeAns.choice as PlacementChoice;
      const validIds = new Set(section.map((c) => c.id));
      const targetOf = (id: string | undefined): string | undefined => {
        if (!id) return undefined;
        // 'new' is valid for every target slot; a candidate id must be listed.
        if (id === 'new') return 'new';
        return validIds.has(id) ? id : undefined;
      };
      let targets: string[] = [];
      let invalid = false;
      if (choice === 'new') {
        targets = ['new'];
      } else if (choice === 'other') {
        const t = targetOf((result.answers.target as { choice?: string } | undefined)?.choice);
        if (t === undefined) {
          invalid = true;
        } else {
          targets = [t];
        }
      } else if (choice === 'split2' || choice === 'split3') {
        const wanted = choice === 'split2' ? ['target', 'target2'] : ['target', 'target2', 'target3'];
        const seen = new Set<string>();
        for (const q of wanted) {
          const t = targetOf((result.answers[q] as { choice?: string } | undefined)?.choice);
          if (t === undefined) {
            invalid = true;
            continue;
          }
          if (!seen.has(t)) {
            seen.add(t);
            targets.push(t);
          }
        }
      }
      let finalChoice: PlacementChoice = choice;
      if (invalid) {
        // §1.1: an invalid/unknown placement target downgrades to `current`
        // with shadow reason 'invalid-target'.
        finalChoice = 'current';
        targets = [];
      }
      out.placement = {
        choice: finalChoice,
        targets,
        ...(truncated ? { truncated: true } : {}),
        ...(invalid ? { invalidTarget: true } : {}),
      };
    } else if (hasCandidates) {
      // placement asked but the CHOICE answer was absent/garbage (M1
      // fail-open contract + adjudication 2026-09-19): degrade to `current`
      // — the in-place no-op — and record the COMPLETENESS failure
      // ('+absent-placement') distinctly from a validation failure
      // ('+invalid-target'), so the flip review can count both classes.
      out.placement = {
        choice: 'current',
        targets: [],
        absentChoice: true,
        ...(truncated ? { truncated: true } : {}),
      };
    } else {
      out.placement = undefined;
    }

    // steer/wait — the answer when valid; ABSENT/INVALID degrades to 'wait'
    // (M1: wait IS the default behavior, so the parse-boundary fail-open
    // records the queue-behind decision). Consulted only for 'current'
    // placements downstream (§4.3).
    if ((input.currentInflight ?? []).length > 0) {
      const swAns = result.answers.steer_wait;
      out.steerWait =
        swAns && swAns.type === 'choice' && (swAns.choice === 'steer' || swAns.choice === 'wait')
          ? swAns.choice
          : 'wait';
    }

    // chain — the DECISION payload is the probabilities map (decision 20);
    // a missing/invalid answer degrades to the rank-order chain.
    const chainAns = result.answers.chain;
    if (chainAns && chainAns.type === 'choice' && chainAns.probabilities && Object.keys(chainAns.probabilities).length > 0) {
      out.chainP = { ...chainAns.probabilities };
    }

    return out;
  } catch {
    return undefined;
  }
}

// The target questions share the candidate-id option set; only the
// instructions differ.
function targetQuestion(
  candidates: Array<{ id: string; goal: string; status: string; inflight: boolean }>,
  instructions: string
) {
  return {
    type: 'choice' as const,
    instructions,
    criteria: Object.fromEntries([
      ...candidates.map((c) => [
        c.id,
        {
          what: `the conversation "${c.goal}" (${c.status}${c.inflight ? ', in flight' : ''})`,
          not_for: undefined,
          examples: [] as string[],
        },
      ]),
      ['new', { what: 'a brand-new conversation', not_for: undefined, examples: [] as string[] }],
    ]),
  };
}
