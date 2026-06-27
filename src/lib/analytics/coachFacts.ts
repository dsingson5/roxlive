/**
 * Tier-3 harvest: MBP-beta's domain heuristics distilled into a guidance block
 * for the Claude coach prompt. We DON'T port MBP's monolithic rule engine —
 * instead we hand Claude its embedded constants so its (flexible) prescriptions
 * are grounded in the same sports-science logic. Pure data + a text builder.
 */

export const COACH_GUIDANCE = [
  "Reference heuristics (use as grounding, adapt to the athlete — these are not hard rules):",
  "• Aerobic decoupling: run <5% / bike-erg <3% = Elite (can progress); run 5-8% / bike-erg 3-5% = Adapting (hold); above that = lessen output or duration. Negative drift on a run is usually a terrain/conditions artifact, not fitness.",
  "• Training load (hrTSS, 100 = one hour at threshold): <60 mostly recovered next day; 60-120 a solid session; >150 needs real recovery. Form/TSB (CTL−ATL): positive = fresh, −10 to −30 = productive overload, below −30 = overreached (back off).",
  "• Refuel: replace ~50% of carbs burned within ~1-2 h. Carbohydrate ≈ 4 kcal/g; pair with protein (~0.3 g/kg). Hydration: ~500-750 ml fluid per hour lost, with ~500-700 mg sodium per litre.",
  "• Polarization: LT1 (aerobic threshold) ≈ 75-78% max HR (or the DFA-α1≈0.75 crossing). Easy days should sit well below LT1; keep ~80% of weekly time easy.",
  "• Durability: a rising cardiac cost (beats/km) or an EF 'bend' late in a long effort signals fatigue/under-fuelling/heat — note when it happened and the likely driver.",
  "• Breathing: average >30 brpm suggests work near/above VT2; a rising breath-rate or breath/HR ratio across halves indicates accumulating strain.",
].join("\n");
