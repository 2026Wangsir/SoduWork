/*
 * Initial conversation specification covers model, directory, permissions, capabilities,
 * and intent. Apply later permission revisions at turn boundaries so renderer choices
 * match actual execution.
 */
'use strict';

const goalContract = require('./goal-contract');

function text(value, max) { return String(value || '').trim().slice(0, max); }

function build(raw, resolved, defaults) {
  const input = raw || {};
  const fallback = defaults || {};
  const capabilityIds = Object.freeze([...(resolved.capabilityIds || [])]);
  const selectedSkills = Object.freeze([...(resolved.selectedSkills || [])]);
  const skillDirs = Object.freeze([...(resolved.skillDirs || [])]);
  const warnings = Object.freeze([...(resolved.warnings || [])]);
  const mode = text(input.mode, 20);
  const readOnly = mode === 'readonly' ? true
    : mode === 'full' ? false : Boolean(fallback.readOnly);
  const goal = goalContract.normalize(input);
  return Object.freeze({
    schemaVersion: 4,
    modelName: text(input.modelName, require('../../core/model-choice').nameLimit(input.modelName)),
    reasoningEffort: text(input.reasoningEffort, 24).toLowerCase(),
    cwd: text(input.cwd || fallback.cwd, 1200),
    readOnly: input.accessPolicy ? input.accessPolicy.mode === 'readonly' : readOnly,
    accessPolicy: require('../access-control/policy').normalize(input.accessPolicy, fallback.cwd || input.cwd),
    thinkingLevel: text(input.thinkingLevel, 40) || (goal.intent === 'goal' ? 'high' : ''),
    taskRef: text(input.taskRef, 120),
    taskTitle: text(input.taskTitle, 200),
    intent: goal.intent,
    goal: goal.goal,
    acceptance: goal.acceptance,
    budgetMinutes: goal.budgetMinutes,
    maxSteps: goal.maxSteps,
    capabilityIds,
    selectedSkills,
    skillDirs,
    optionalSkillDirs: Object.freeze([...(resolved.optionalSkillDirs || [])]),
    warnings,
  });
}

module.exports = { build };
