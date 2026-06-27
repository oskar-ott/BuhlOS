'use strict';

// Per-job profitability computation (#327, Epic 14). Pure margin maths with an
// HONEST data-completeness statement — a margin is never presented as more
// certain than its inputs.
//
// CJS so the serverless handler (api/job-profitability.js) can require it; the
// admin UI consumes the endpoint's JSON, so there is no second (TS) copy to keep
// in parity. Money is INTEGER CENTS throughout (P7; aligns with the cost-rate
// store #304).
//
// Honesty rules:
//   - No contract value → margin is null ("no contract value set"), never faked.
//   - Labour from workers with NO cost rate is not silently costed at 0 — it is
//     excluded and those workers are named (labour "understated").
//   - Material cost is labelled by source (real consumption / received-rollup
//     proxy / none) so a proxy is never read as truth.

/**
 * @param {{ contractValueCents: number|null, labourCostCents: number,
 *           unratedWorkers: string[], materialCostCents: number|null,
 *           materialSource: 'consumption'|'received_proxy'|'none' }} input
 */
function computeJobProfitability(input) {
  const labourCostCents = Math.max(0, Math.round((input && input.labourCostCents) || 0));
  const materialCostCents =
    input && input.materialCostCents == null ? 0 : Math.max(0, Math.round(input.materialCostCents));
  const unrated = (input && input.unratedWorkers) || [];
  const labourComplete = unrated.length === 0;

  const contractValueCents =
    input && input.contractValueCents == null ? null : Math.round(input.contractValueCents);

  const marginCents =
    contractValueCents == null ? null : contractValueCents - labourCostCents - materialCostCents;
  const marginPct =
    contractValueCents == null || contractValueCents === 0
      ? null
      : Math.round((marginCents / contractValueCents) * 100);

  const materialSource = (input && input.materialSource) || 'none';
  const badges = [];
  badges.push(
    labourComplete ? 'labour complete' : `${unrated.length} worker${unrated.length === 1 ? '' : 's'} unrated`,
  );
  if (materialSource === 'consumption') badges.push('materials actual');
  else if (materialSource === 'received_proxy') badges.push('materials proxy');
  else badges.push('no material data');
  if (contractValueCents == null) badges.push('no contract value set');

  return {
    contractValueCents,
    labourCostCents,
    materialCostCents,
    marginCents,
    marginPct,
    completeness: {
      labour: labourComplete ? 'complete' : 'understated',
      material: materialSource,
      unratedWorkers: unrated,
    },
    badges,
  };
}

module.exports = { computeJobProfitability };
