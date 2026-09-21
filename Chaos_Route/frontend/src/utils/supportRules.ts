/* Catégories de support à l'encodage d'un retour (ticket #15) /
   Support categories when encoding a return (ticket #15).

   Miroir de `backend/app/utils/support_rules.py`, qui reste la source de vérité :
   le serveur refuse tout support hors périmètre à la soumission. Ici on ne fait
   que présenter les bons supports dans la bonne catégorie.

   - CO ............ contenants (combis, rolls)
   - PA ............ palettes — présentées avec les contenants
   - PL ............ casiers consignés (Jupiler, Maes, Leffe, Duvel…)
   - RE ............ balles carton / plastique
   - SF 40040 / 40104 / 40204 ... contenants (caisse plastique, rolls à fleurs)
   - autres SF ..... casiers bière : hors périmètre retour, filtrés par le serveur
*/

/** Codes SF qui sont des contenants, et non des consignes bière. */
export const CONTAINER_SF_CODES = ['SF40040', 'SF40104', 'SF40204']

/** Majuscules sans espace ni tiret — même normalisation que le serveur. */
export function normalizeSupportCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '')
}

/** Catégorie de reprise d'un code support. */
export function pickupTypeForSupportCode(code: string): string {
  const norm = normalizeSupportCode(code)
  if (norm.startsWith('RE')) return 'CARDBOARD'
  if (CONTAINER_SF_CODES.includes(norm)) return 'CONTAINER'
  if (norm.startsWith('PL') || norm.startsWith('SF')) return 'CONSIGNMENT'
  return 'CONTAINER'
}

/** Le support appartient-il à la catégorie demandée ? */
export function supportMatchesPickupType(code: string, pickupType: string): boolean {
  if (pickupType === 'MERCHANDISE') return false
  return pickupTypeForSupportCode(code) === pickupType
}
