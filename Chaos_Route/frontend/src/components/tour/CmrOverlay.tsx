/* Calque CMR sur formulaire pré-imprimé (#50).

   Samuel : « nous avons un modèle Word, que nous imprimons directement sur un
   papier déjà prérempli ». Les photos montrent un formulaire FEBETRA en
   continu, pré-numéroté, et un document Word qui ne contient QUE du texte,
   positionné pour tomber dans les cases.

   Le CMR que CMRO produisait jusqu'ici dessine ses propres cadres et ses
   propres libellés : imprimé sur ce papier, il se superpose au formulaire. Ce
   composant fait l'inverse — page blanche, aucun cadre, aucun libellé, rien que
   les valeurs, chacune posée à une position en millimètres.

   DEUX PRÉCAUTIONS, parce qu'un calque mal réglé est un document illisible :

   1. Toutes les positions sont exprimées en millimètres dans UN seul tableau
      ci-dessous, et décalables globalement. Un formulaire chargé deux
      millimètres plus haut se rattrape sans toucher au code — le réglage est
      dans l'écran, conservé sur le poste.
   2. Une MIRE d'alignement imprime les cadres attendus en gris clair. On la
      sort sur une feuille vierge, on la superpose au formulaire à contre-jour,
      et on lit le décalage à appliquer. Elle évite de gâcher des liasses
      pré-numérotées pour trouver le bon réglage.

   Les positions par défaut sont relevées sur la photo d'un exemplaire rempli
   fournie par Samuel. Elles sont approchées tant que le .docx d'origine ou un
   relevé du formulaire vierge n'a pas été fourni : c'est précisément ce que la
   calibration permet d'absorber. */

import { useCallback, useEffect, useState } from 'react'
import api from '../../services/api'
import type { WaybillData } from '../../types'

interface Props {
  tourId: number
  onClose: () => void
}

/* Réglage conservé sur le poste : c'est une propriété de l'imprimante et du
   bac de papier, pas de l'utilisateur ni du serveur. */
const CALIBRAGE_KEY = 'cmr-overlay-calibration'

interface Calibrage {
  offsetX: number
  offsetY: number
  largeurMm: number
  hauteurMm: number
  taillePolice: number
}

const CALIBRAGE_DEFAUT: Calibrage = {
  offsetX: 0,
  offsetY: 0,
  /* Formulaire FEBETRA en continu : 240 mm de large (12 pouces moins les
     bandes à picots) sur 305 mm. À confirmer avec un formulaire sous la main. */
  largeurMm: 240,
  hauteurMm: 305,
  taillePolice: 10,
}

function chargerCalibrage(): Calibrage {
  try {
    const brut = localStorage.getItem(CALIBRAGE_KEY)
    if (brut) return { ...CALIBRAGE_DEFAUT, ...JSON.parse(brut) }
  } catch { /* réglage illisible : on repart du défaut */ }
  return CALIBRAGE_DEFAUT
}

/* Une case du formulaire : position du coin haut-gauche et largeur utile. */
interface Case {
  cle: string
  numero: string
  libelle: string
  x: number
  y: number
  largeur: number
  hauteur: number
  gras?: boolean
}

const CASES: Case[] = [
  { cle: 'expediteur', numero: '1', libelle: 'Expéditeur', x: 22, y: 48, largeur: 90, hauteur: 22 },
  { cle: 'destinataire', numero: '2', libelle: 'Destinataire', x: 24, y: 76, largeur: 88, hauteur: 20 },
  { cle: 'priseEnCharge', numero: '3', libelle: 'Prise en charge', x: 20, y: 104, largeur: 92, hauteur: 8 },
  { cle: 'livraison', numero: '4', libelle: 'Livraison', x: 24, y: 118, largeur: 88, hauteur: 12 },
  { cle: 'transporteur', numero: '5', libelle: 'Transporteur principal', x: 126, y: 50, largeur: 90, hauteur: 22 },
  { cle: 'marchandises', numero: '10', libelle: 'Marchandises', x: 34, y: 186, largeur: 100, hauteur: 8 },
  { cle: 'equivalents', numero: '10', libelle: 'Équivalents', x: 34, y: 210, largeur: 30, hauteur: 6 },
  { cle: 'poids', numero: '10', libelle: 'Poids (kg)', x: 152, y: 208, largeur: 28, hauteur: 6 },
  { cle: 'documents', numero: '11', libelle: 'Documents annexes', x: 22, y: 254, largeur: 80, hauteur: 6 },
  { cle: 'lieuDate', numero: '12', libelle: 'Lieu et date', x: 22, y: 268, largeur: 90, hauteur: 6 },
  { cle: 'dateEtablissement', numero: '14', libelle: 'Date', x: 22, y: 276, largeur: 60, hauteur: 6 },
  { cle: 'cachetExpediteur', numero: '14', libelle: 'Cachet expéditeur', x: 30, y: 286, largeur: 70, hauteur: 16 },
  { cle: 'cachetTransporteur', numero: '15', libelle: 'Cachet transporteur', x: 110, y: 286, largeur: 70, hauteur: 16 },
]

export function CmrOverlay({ tourId, onClose }: Props) {
  const [data, setData] = useState<WaybillData | null>(null)
  const [loading, setLoading] = useState(true)
  const [cal, setCal] = useState<Calibrage>(chargerCalibrage)
  const [mire, setMire] = useState(false)
  const [stopIndex, setStopIndex] = useState(0)

  useEffect(() => {
    api.get(`/tours/${tourId}/waybill`)
      .then((r) => setData(r.data))
      .catch((e) => console.error('CMR overlay', e))
      .finally(() => setLoading(false))
  }, [tourId])

  const majCal = useCallback((champ: keyof Calibrage, valeur: number) => {
    setCal((prev) => {
      const suivant = { ...prev, [champ]: valeur }
      try { localStorage.setItem(CALIBRAGE_KEY, JSON.stringify(suivant)) } catch { /* privé */ }
      return suivant
    })
  }, [])

  /* Un CMR par destinataire : le formulaire n'a qu'une case « destinataire »,
     une tournée en a autant que d'arrêts. On imprime celui de l'arrêt choisi. */
  const stop = data?.stops?.[stopIndex]

  const valeurs: Record<string, string[]> = data ? {
    expediteur: [
      'SCAPR',
      'Rue du Bosquet N° 4',
      'B- 1348 Louvain la Neuve Belgique',
      'T.V.A. B.E 458.113.776-RNC 72.520',
    ],
    destinataire: stop
      ? [stop.pdv_code, stop.address ?? '', `${stop.postal_code ?? ''} ${stop.city ?? ''}`.trim(), 'Belgique']
      : [],
    priseEnCharge: [
      `${data.base?.city ?? ''} BELGIQUE, le ${data.date ?? ''}`,
    ],
    livraison: stop ? [stop.address ?? '', `${stop.city ?? ''} Belgique`] : [],
    transporteur: [
      data.contract?.transporter_name ?? '',
      data.contract?.carrier_address ?? '',
      `${data.contract?.carrier_postal_code ?? ''} ${data.contract?.carrier_city ?? ''}`.trim(),
      data.contract?.carrier_vat_number ? `TVA ${data.contract.carrier_vat_number}` : '',
    ].filter(Boolean),
    marchandises: ['Marchandises pour grande distribution'],
    equivalents: [stop ? `${stop.eqp_count} équivalents` : ''],
    poids: [stop && stop.weight_kg ? `${Math.round(stop.weight_kg)} Kg` : ''],
    documents: ['Bordereau de livraison'],
    lieuDate: [`${data.base?.city ?? ''} BELGIQUE    le`],
    dateEtablissement: [data.date ?? ''],
    cachetExpediteur: ['SCA PR S.A.', 'Rue du Bosquet N°4', 'B- 1348 Louvain la Neuve', 'Belgique'],
    cachetTransporteur: [
      data.contract?.transporter_name ?? '',
      data.contract?.carrier_address ?? '',
      `${data.contract?.carrier_postal_code ?? ''} ${data.contract?.carrier_city ?? ''}`.trim(),
    ].filter(Boolean),
  } : {}

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="print-hide flex flex-wrap items-center gap-3 px-6 py-3 border-b"
        style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          CMR — calque sur formulaire pré-imprimé
        </h2>

        {data && data.stops.length > 1 && (
          <select value={stopIndex} onChange={(e) => setStopIndex(Number(e.target.value))}
            className="px-2 py-1.5 rounded-lg border text-sm"
            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
            {data.stops.map((s, i) => (
              <option key={i} value={i}>{s.pdv_code} — {s.city}</option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-2 ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
          {([
            ['Décalage X (mm)', 'offsetX', 0.5],
            ['Décalage Y (mm)', 'offsetY', 0.5],
            ['Police (pt)', 'taillePolice', 0.5],
          ] as [string, keyof Calibrage, number][]).map(([label, champ, pas]) => (
            <label key={champ} className="flex items-center gap-1">
              {label}
              <input type="number" step={pas} value={cal[champ]}
                onChange={(e) => majCal(champ, Number(e.target.value))}
                className="w-16 px-1 py-1 rounded border text-xs"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
            </label>
          ))}
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={mire} onChange={(e) => setMire(e.target.checked)} />
            Mire d&apos;alignement
          </label>
        </div>

        <button onClick={() => window.print()}
          className="px-4 py-2 rounded-lg text-sm font-semibold"
          style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}>
          Imprimer
        </button>
        <button onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm font-semibold border"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
          Fermer
        </button>
      </div>

      <div className="print-hide px-6 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        Cochez <strong>Mire d&apos;alignement</strong> et imprimez sur une feuille blanche :
        superposez-la au formulaire à contre-jour, lisez le décalage, reportez-le ci-dessus.
        Le réglage reste enregistré sur ce poste. N&apos;imprimez sur une liasse pré-numérotée
        qu&apos;une fois l&apos;alignement bon.
      </div>

      <div className="flex-1 overflow-auto p-4 print-content">
        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0' }}>Chargement…</p>
        ) : !data ? (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0' }}>Aucune donnée</p>
        ) : (
          <div
            className="cmr-overlay-page"
            style={{
              position: 'relative',
              width: `${cal.largeurMm}mm`,
              height: `${cal.hauteurMm}mm`,
              margin: '0 auto',
              backgroundColor: '#fff',
              color: '#000',
              fontFamily: '"Times New Roman", Times, serif',
              fontSize: `${cal.taillePolice}pt`,
              /* Un liseré à l'écran seulement : à l'impression, rien. */
              outline: '1px dashed #ccc',
            }}
          >
            {CASES.map((c) => {
              const lignes = valeurs[c.cle] ?? []
              return (
                <div key={c.cle} style={{
                  position: 'absolute',
                  left: `${c.x + cal.offsetX}mm`,
                  top: `${c.y + cal.offsetY}mm`,
                  width: `${c.largeur}mm`,
                  minHeight: `${c.hauteur}mm`,
                  lineHeight: 1.25,
                  whiteSpace: 'pre-line',
                  ...(mire ? { outline: '0.3mm solid #bbb' } : {}),
                }}>
                  {mire && (
                    <span style={{ position: 'absolute', top: '-4mm', left: 0, fontSize: '6pt', color: '#999' }}>
                      {c.numero} · {c.libelle}
                    </span>
                  )}
                  {lignes.filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <style>{`
        @media print {
          @page { size: ${cal.largeurMm}mm ${cal.hauteurMm}mm; margin: 0; }
          .print-hide { display: none !important; }
          .cmr-overlay-page { outline: none !important; margin: 0 !important; }
        }
      `}</style>
    </div>
  )
}
