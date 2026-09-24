// engine.js — the clinical decision tree. Thresholds are the calibration
// surface: tune them against the practitioner's manual diagnoses.
export const THRESHOLDS = {
  achillesStraightMax: 3,   // deg; ≤ this = straight tendon, no pronatory collapse
  achillesFlatMin: 6,       // deg; > this = flat-foot pattern
  collapseFlatMin: 37,      // %; single-leg loading collapse above this = flat
  kneeAxisNoteMin: 3,       // deg; |knee axis| above this is flagged
};

// Decision tree (order matters):
// 1. Achilles line is the primary indicator.
//    Straight (≈90° to floor) → no collapse → knee axis decides:
//    varus (O-legs, negative) supports HIGH ARCH.
// 2. Broken inward → tendon pulls the knee medially → collapse is
//    confirmed by the single-leg loading test: FLAT vs LOW arch.
// collapse may be null when the single-leg loading test was not run —
// the tree then rests on the Achilles line and knee axis alone.
export function classify(f, t = THRESHOLDS) {
  const hasCollapse = f.collapse != null;
  if (f.ach <= t.achillesStraightMax) {
    return {
      cls: 'high', name: 'קשת גבוהה', color: 'var(--high)',
      why: `גיד אכילס ישר (${f.ach}°) — אין קריסה פנימה. ציר הברך ${f.knee < 0 ? 'בוורוס (דפוס רגלי O)' : 'ניטרלי'} (${f.knee}°)${hasCollapse ? ` וקריסת ההעמסה מזערית (${f.collapse}%)` : ''} — דפוס קשת גבוהה.`,
      plain: 'כף הרגל נוקשה וסופגת פחות זעזועים — העומס מתרכז בעקב ובכרית האצבעות.',
      spec: ['ספיגת זעזועים מוגברת בעקב ובכרית', 'מילוי ותמיכה מלאה לאורך הקשת', 'הקלה על עומס צידי (סופינציה)'],
    };
  }
  if (f.ach > t.achillesFlatMin || (hasCollapse && f.collapse > t.collapseFlatMin)) {
    return {
      cls: 'flat', name: 'פלטפוס', color: 'var(--flat)',
      why: `גיד אכילס נשבר פנימה (${f.ach}°) ומושך את הברך מדיאלית (${f.knee}°)${hasCollapse ? `. במבחן ההעמסה הקשת קרסה ${f.collapse}%` : ''} — דפוס פלטפוס.`,
      plain: 'הקרסול קורס פנימה בכל דריכה — הקשת לא תומכת, והעומס נמשך לצד הפנימי של הרגל ולברך.',
      spec: ['תמיכת קשת מלאה וקשיחה', 'ייצוב עקב עמוק (Heel Cup)', 'הגבהה מדיאלית לתיקון ציר הברך'],
    };
  }
  return {
    cls: 'low', name: 'קשת נמוכה', color: 'var(--low)',
    why: `סטייה מתונה בגיד אכילס (${f.ach}°) עם משיכה קלה של הברך פנימה (${f.knee}°)${hasCollapse ? ` וקריסת העמסה חלקית (${f.collapse}%)` : ''} — קשת נמוכה.`,
    plain: 'הקשת שוקעת חלקית בדריכה — נטייה פנימה שמעמיסה על הצד הפנימי של הרגל.',
    spec: ['תמיכת קשת בינונית', 'ייצוב עקב', 'חלוקת עומס מחודשת קדימה'],
  };
}

export const LOGIC_LINE =
  'שיטת האבחון: גיד אכילס הוא המדד המוביל — קו ישר (90° לרצפה) שולל קריסה ומפנה לבדיקת ציר הברך (וורוס = קשת גבוהה); שבירה פנימה מושכת את הברך מדיאלית ומאומתת במבחן העמסה על רגל אחת.';
