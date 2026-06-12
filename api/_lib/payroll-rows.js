// Per-allocation ordinary/overtime proration for the payroll export (#380).
//
// The entry stores the DAY's ordinaryHours/overtimeHours; CSV rows are per
// allocation. Deriving ordinary = min(allocation, 8) independently per row
// made a 10h day split 5h+5h export as 10 ordinary / 0 OT — the overtime
// vanished. This walks the allocations IN ORDER, consuming the day's
// ordinary budget first; whatever spills past it is overtime, so OT lands
// on the last allocation(s) — deterministic, documented, and the row sums
// always conserve the entry's stored totals.
//
// Single-allocation days reduce to min(h, budget) / remainder — byte-
// identical to the previous derivation. When the entry has no stored
// ordinaryHours, the budget falls back to min(total, 8), matching the old
// 8-hour default.

function prorateAllocations(entry, allocations) {
  const hoursOf = (a) => Number(a && a.hours) || 0;
  const total = allocations.reduce((sum, a) => sum + hoursOf(a), 0);
  const ordinaryBudget =
    entry && entry.ordinaryHours != null
      ? Math.max(0, Number(entry.ordinaryHours) || 0)
      : Math.min(total, 8);

  let remaining = ordinaryBudget;
  return allocations.map((a) => {
    const h = hoursOf(a);
    const ordinary = Math.round(Math.min(h, Math.max(0, remaining)) * 100) / 100;
    remaining -= ordinary;
    const overtime = Math.round((h - ordinary) * 100) / 100;
    return { hours: h, ordinaryHours: ordinary, overtimeHours: overtime };
  });
}

module.exports = { prorateAllocations };
