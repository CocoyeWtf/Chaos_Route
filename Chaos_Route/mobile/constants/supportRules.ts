/* Categories de support a l'encodage d'un retour (ticket #15) /
   Support categories when encoding a return (ticket #15).

   Miroir de `backend/app/utils/support_rules.py`, qui reste la source de verite :
   le serveur refuse tout support hors perimetre a la soumission.

   - CO ............ contenants (combis, rolls)
   - PA ............ palettes — presentees avec les contenants
   - PL ............ casiers consignes (Jupiler, Maes, Leffe, Duvel…)
   - RE ............ balles carton / plastique
   - SF 40040 / 40104 / 40204 ... contenants (caisse plastique, rolls a fleurs)
   - autres SF ..... casiers biere : hors perimetre retour, filtres par le serveur
*/

/** Codes SF qui sont des contenants, et non des consignes biere. */
export const CONTAINER_SF_CODES = ['SF40040', 'SF40104', 'SF40204']

/** Majuscules sans espace ni tiret — meme normalisation que le serveur. */
export function normalizeSupportCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '')
}

/** Categorie de reprise d'un code support. */
export function pickupTypeForSupportCode(code: string): string {
  const norm = normalizeSupportCode(code)
  if (norm.startsWith('RE')) return 'CARDBOARD'
  if (CONTAINER_SF_CODES.includes(norm)) return 'CONTAINER'
  if (norm.startsWith('PL') || norm.startsWith('SF')) return 'CONSIGNMENT'
  return 'CONTAINER'
}

/** Le support appartient-il a la categorie demandee ? */
export function supportMatchesPickupType(code: string, pickupType: string): boolean {
  if (pickupType === 'MERCHANDISE') return false
  return pickupTypeForSupportCode(code) === pickupType
}
