# healing Specification

## Purpose

Defines how a run recovers when stored selectors no longer match: the ordered rungs it tries, how a stored fingerprint is scored against live elements, when a recovered selector is promoted into the recipe, and how outcomes are reported.

## Requirements

### Requirement: Healing ladder
For each target (item container, each field, pagination target, each step target) the runner SHALL try, in order: (1) the stored candidates in listed order; (2) fuzzy fingerprint match against the live page when the target has a fingerprint; (3) the model rung when a language model is available and enabled for the recipe; (4) the human re-pick rung when a handler is available; (5) failure. The first rung that resolves at least one element SHALL win and later rungs SHALL NOT run for that target. Healing SHALL be attempted once per target per run, not per row.

#### Scenario: Candidate rung wins
- **WHEN** the second stored candidate resolves elements
- **THEN** fuzzy matching is not attempted for that target and the outcome is `candidate` with index 1

#### Scenario: Fuzzy rung wins
- **WHEN** no stored candidate resolves and fuzzy matching finds an element above the threshold
- **THEN** the target resolves to that element and the outcome is `fuzzy` with its score

#### Scenario: Model rung wins
- **WHEN** candidates and fuzzy match fail and the model picks a candidate that verifies
- **THEN** the target resolves to that element and the outcome is `model` with the model's reason

#### Scenario: Ladder exhausted
- **WHEN** no rung resolves a required field
- **THEN** the field is treated as missing per the runner's missing-field policy

#### Scenario: Step target healed
- **WHEN** a step's stored candidates fail and the fuzzy rung finds its target
- **THEN** the step runs on that element and the outcome is `fuzzy`

### Requirement: Fingerprint similarity score
The score between a stored fingerprint and a live element SHALL be a weighted sum in the range 0 to 1 of: tag equality (0.15), role equality (0.15), accessible name similarity (0.15), text sample similarity (0.20), stable attribute overlap (0.15), ancestor token sequence similarity (0.10), and bounding box proximity relative to the viewport (0.10). String similarities SHALL use a normalized edit distance on trimmed, case-folded text. A component whose data is absent on both sides SHALL contribute its full weight; absent on one side SHALL contribute zero.

#### Scenario: Same element after class hashing
- **WHEN** the live element differs from the fingerprint only in class names
- **THEN** the score is at least 0.9

#### Scenario: Different field of the same card
- **WHEN** the fingerprint is the price and the live element is the title in the same card
- **THEN** the score is below 0.7

### Requirement: Fuzzy search space and threshold
Fuzzy matching SHALL score elements within the target's scope: inside the resolved item container for item scoped fields, inside the resolved list parent for the container when `within` is present, inside the document for page scoped fields, the list parent, and the container without `within`. Only elements whose tag equals the fingerprint tag, or whose role equals the fingerprint role, SHALL be scored. The best element SHALL be accepted when its score is at least the recipe's `healing.fuzzyThreshold` and exceeds the runner-up by at least 0.05; otherwise the rung fails. For item scoped fields the match SHALL be established on one container, the one that best matches the item fingerprint at or above the threshold, else the first container, and the derived selector verified to resolve in at least half of the containers. The ancestor component SHALL tolerate up to 3 wrapper elements inserted between the element and its stored ancestors.

#### Scenario: Ambiguous match rejected
- **WHEN** two elements score 0.82 and 0.80 against a fingerprint with threshold 0.7
- **THEN** the fuzzy rung fails for that target

#### Scenario: Items reordered
- **WHEN** the page shuffles its items and item scoped fields must be matched by fingerprint
- **THEN** matching runs in the item whose content matches the item fingerprint, not in whichever item comes first

#### Scenario: Item field verified across containers
- **WHEN** the fuzzy match in the first container yields a selector that resolves in 20 of 24 containers
- **THEN** the match is accepted and the field is `partial` on the 4 rows where it is missing

#### Scenario: Container healed inside the list parent
- **WHEN** the container selector breaks, `within` still resolves, and a sidebar holds elements with the same tag
- **THEN** fuzzy matching for the container scores only elements inside the list parent

### Requirement: Promotion after healing
When a target resolves by any rung other than its first stored candidate, the runner SHALL generate fresh candidates for the resolved element using selector generation, place the resolving selector first, append previous candidates that still resolve after it, drop candidates that no longer resolve, and refresh the fingerprint from the live element. The promoted recipe SHALL be written to its original location only after the run completes successfully and only when write-back is enabled. Write-back SHALL preserve every recipe field the runner did not change.

#### Scenario: Promoted candidate written back
- **WHEN** a run heals `price` through fuzzy matching, succeeds, and write-back is enabled
- **THEN** the recipe file's `price.selectors[0]` is the new selector and its fingerprint is refreshed

#### Scenario: Failed run does not write
- **WHEN** a run heals one field and then fails on another required field
- **THEN** the recipe file is unchanged

#### Scenario: Write-back disabled
- **WHEN** write-back is disabled and a field heals
- **THEN** the run succeeds and the recipe file is unchanged

### Requirement: Healing disabled
When healing is disabled, only the first stored candidate SHALL be tried for each target, no promotion SHALL occur, and a target that does not resolve SHALL be treated as missing.

#### Scenario: Healing off, second candidate ignored
- **WHEN** healing is disabled and only the second candidate would resolve
- **THEN** the field is missing

### Requirement: Healing outcomes reported
For every target the report SHALL record the outcome `candidate` with index, `fuzzy` with score, `model` with its rationale when that rung exists, or `unresolved`. A field resolved by any rung other than candidate index 0 SHALL have status `healed` unless it is also `partial`, in which case status SHALL be `partial` and the healing outcome still recorded. A `field.healed` event SHALL be emitted for each healed target with the outcome, old primary selector, and new primary selector.

#### Scenario: Healed field in report
- **WHEN** `price` resolves through candidate index 2
- **THEN** the report lists `price` with status `healed` and outcome `candidate` index 2

### Requirement: Human re-pick as the last rung
When the ladder fails for a required target and an interactive re-pick handler is available, the runner SHALL invoke it with the target's name, old primary selector, fingerprint, and last known sample value, wait for the user to select a new element or skip, and continue the run with the new selection. Without a handler the run SHALL fail as missing. A re-pick SHALL count as a healing outcome `user` and SHALL be promoted and written back like any other rung.

#### Scenario: Interactive run re-picks
- **WHEN** `price` cannot be healed and a re-pick handler is available
- **THEN** the run pauses, the user selects the new price element, and the run resumes with all rows carrying prices

#### Scenario: User skips
- **WHEN** the user skips the re-pick for a required field
- **THEN** the run fails as missing for that field

### Requirement: Model rung gating
The model rung SHALL run only when all hold: an adapter is available, the recipe's `healing.llm` is true, and the run was not started with the model disabled. When the adapter reports an error, the rung SHALL fail for that target, log one line, and SHALL NOT be attempted again for the remaining targets of the run.

#### Scenario: Recipe opts out
- **WHEN** `healing.llm` is false and fuzzy match fails
- **THEN** the model is not called and the ladder proceeds to re-pick or failure

#### Scenario: Endpoint fails mid-run
- **WHEN** the first model call errors
- **THEN** later targets in the same run skip the model rung

### Requirement: Candidate pruning for the model
Before asking the model, the rung SHALL build a candidate list from the target's scope: elements whose tag is in the field type's plausible set (`text` and `number`: any element with own text; `url`: anchors; `image`: images and elements with a background image attribute; `date`: elements with own text or a `datetime` attribute; `html`: any element), excluding script, style, and hidden elements, ranked by fingerprint score, capped so that the serialized prompt fits within 40 percent of the configured context window and never exceeds 60 candidates. Each candidate SHALL be serialized as one line with its index, tag, role, key attributes, own text truncated to 80 characters, and its ancestor path truncated to 4 tokens.

#### Scenario: Budget respected
- **WHEN** the scope has 400 plausible elements and the context window is 32768 tokens
- **THEN** the prompt contains at most 60 candidates and its estimated size is at most 13107 tokens

#### Scenario: Type filter
- **WHEN** the target is a `url` field
- **THEN** only anchor elements appear in the candidate list

### Requirement: Model prompt and answer contract
The prompt SHALL contain the field's name and type, the stored fingerprint (tag, role, name, text sample, stable attributes, ancestors), the last known sample value when present, and the candidate list. The model SHALL answer with a JSON object `{ "index": <integer or null>, "confidence": <0 to 1>, "reason": <string> }`. Answers with an index outside the list, a missing field, or confidence below 0.5 SHALL count as no pick.

#### Scenario: Low confidence ignored
- **WHEN** the model answers index 4 with confidence 0.3
- **THEN** the rung fails for that target

#### Scenario: Null pick
- **WHEN** the model answers index null
- **THEN** the rung fails for that target and the report records the model's reason

### Requirement: Model pick verification
A model pick SHALL be verified before acceptance: the picked element SHALL resolve through its positional selector; for item scoped fields the promoted relative selector SHALL resolve in at least half of the containers; the picked element's fingerprint score SHALL be at least 0.4; and for `number` and `date` fields the picked element's text SHALL convert to a non-null value. A pick that fails verification SHALL count as no pick.

#### Scenario: Pick fails type check
- **WHEN** the model picks an element for a `number` field whose text has no digits
- **THEN** the rung fails for that target

#### Scenario: Pick verified across containers
- **WHEN** the model picks the new price element in the first container and the relative selector resolves in 24 of 24 containers
- **THEN** the target is healed with outcome `model`

### Requirement: Removed field is not invented
When a target's field no longer exists on the page, the ladder SHALL end in `unresolved` rather than accept a wrong element. This is enforced by the confidence floor, the score floor, and the type check together.

#### Scenario: Tier 4 rating removed
- **WHEN** the page no longer contains any rating element and `rating` is required
- **THEN** the run reports `rating` as `missing` with outcome `unresolved` and exits 3, and no other field's value is placed into `rating`
### Requirement: List parent healing
The list parent in `item.within` SHALL be a healing target with its own fingerprint, healed before the container with the same ladder. Promotion after healing SHALL apply to `within` like any other target. When `within` cannot be healed, the container SHALL be resolved against the document and the outcome reported as `within` missing.

#### Scenario: List parent renamed
- **WHEN** the list's class changes and its role stays `list`
- **THEN** `within` heals through its `role` candidate or the fuzzy rung and the run proceeds with 24 rows
