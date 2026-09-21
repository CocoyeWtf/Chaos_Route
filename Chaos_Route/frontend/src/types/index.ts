/* Types TypeScript pour Chaos RouteManager / TypeScript types */

export interface Country {
  id: number
  name: string
  code: string
}

export interface Region {
  id: number
  name: string
  country_id: number
}

export interface BaseActivity {
  id: number
  code: string
  name: string
}

export interface BaseLogistics {
  id: number
  code: string
  name: string
  address?: string
  postal_code?: string
  city?: string
  phone?: string
  email?: string
  longitude?: number
  latitude?: number
  region_id: number
  billing_company?: string
  activities: BaseActivity[]
}

export type PDVType =
  | 'EXPRESS' | 'CONTACT' | 'SUPER_ALIMENTAIRE' | 'SUPER_GENERALISTE'
  | 'HYPER' | 'NETTO' | 'DRIVE' | 'URBAIN_PROXI'

export interface PDV {
  id: number
  code: string
  name: string
  address?: string
  postal_code?: string
  city?: string
  phone?: string
  email?: string
  longitude?: number
  latitude?: number
  type: PDVType
  has_sas_sec: boolean
  sas_sec_surface_m2?: number
  sas_sec_capacity_eqc?: number
  has_sas_frais: boolean
  sas_frais_surface_m2?: number
  sas_frais_capacity_eqc?: number
  has_sas_gel: boolean
  sas_gel_surface_m2?: number
  sas_gel_capacity_eqc?: number
  is_day_sec: boolean
  is_day_frais: boolean
  is_day_gel: boolean
  has_dock_sec: boolean
  has_dock_frais: boolean
  has_dock_gel: boolean
  has_dock: boolean
  dock_has_niche: boolean
  dock_time_minutes?: number
  unload_time_per_eqp_minutes?: number
  delivery_window_start?: string
  delivery_window_end?: string
  delivery_window_sec_start?: string
  delivery_window_sec_end?: string
  delivery_window_frais_start?: string
  delivery_window_frais_end?: string
  delivery_window_gel_start?: string
  delivery_window_gel_end?: string
  site_plan_url?: string
  access_constraints?: string
  allowed_vehicle_types?: string
  region_id: number
}

export type TemperatureType = 'GEL' | 'FRAIS' | 'SEC' | 'BI_TEMP' | 'TRI_TEMP'
export type VehicleType = 'SEMI' | 'SEMI_COURTE' | 'PORTEUR' | 'PORTEUR_SURBAISSE' | 'PORTEUR_REMORQUE' | 'CITY' | 'VL'
export type TailgateType = 'RETRACTABLE' | 'RABATTABLE'

export interface Supplier {
  id: number
  code: string
  name: string
  address?: string
  postal_code?: string
  city?: string
  phone?: string
  email?: string
  longitude?: number
  latitude?: number
  region_id: number
}

export interface Carrier {
  id: number
  code: string
  name: string
  address?: string
  postal_code?: string
  city?: string
  country?: string
  phone?: string
  email?: string
  transport_license?: string
  vat_number?: string
  siren?: string
  accounting_code?: string
  contact_person?: string
  notes?: string
  region_id: number
}

export type TemperatureClass = 'SEC' | 'FRAIS' | 'GEL'

export interface CnufTemperature {
  id: number
  cnuf: string
  filiale: string
  temperature_type: string
  label?: string
  base_id?: number
}

export interface Volume {
  id: number
  pdv_id: number
  date: string
  nb_colis?: number
  eqp_count: number
  weight_kg?: number
  temperature_class: TemperatureClass
  base_origin_id: number
  preparation_start?: string
  preparation_end?: string
  dispatch_date?: string | null
  dispatch_time?: string | null
  tour_id?: number | null
  volume_m3?: number | null
  nb_supports?: number | null
  activity_type?: string | null      // 'SUIVI' | 'MEAV'
  promo_start_date?: string | null   // YYYY-MM-DD
  split_group_id?: number | null
  // Reste à quai (#68) : marchandise non chargée, remise à disposition, avec le
  // code de la tournée d'où elle vient. / Left at the dock, back in the pool.
  is_raq?: boolean
  raq_from_tour_code?: string | null
  pdv_code?: string | null           // Numéro PDV résolu côté serveur / PDV number from server
  pdv_name?: string | null
}

export type TourStatus = 'DRAFT' | 'VALIDATED' | 'IN_PROGRESS' | 'RETURNING' | 'COMPLETED'

export interface TourStop {
  id: number
  tour_id: number
  pdv_id: number
  /** Volume source exact de ce stop (livraison). Absent pour un stop de reprise
   *  (pickup, eqp 0). Clé UNIQUE d'un segment : indispensable quand un PDV a
   *  plusieurs volumes de même eqc (ex. Gel 9.96 + Frais 9.96) — sinon la carte
   *  ne sait plus lequel a été pris. / Exact source volume of this stop. */
  volume_id?: number
  sequence_order: number
  eqp_count: number
  arrival_time?: string
  departure_time?: string
  distance_from_previous_km?: number
  duration_from_previous_minutes?: number
  pickup_cardboard?: boolean
  pickup_containers?: boolean
  pickup_returns?: boolean
  pickup_consignment?: boolean
  delivery_status?: string
  actual_arrival_time?: string
  actual_departure_time?: string
  missing_supports_count?: number
  forced_closure?: boolean
  delivery_notes?: string
  /** Classe de température (renseigné pendant la construction du tour) */
  temperature_class?: TemperatureClass
}

// Nature de tournée / Tour nature (LIVRAISON = livraison classique)
export type TourType = 'LIVRAISON' | 'ENLEVEMENT' | 'VIDANGES' | 'DEPLACEMENT_BASE' | 'GARAGE' | 'TRANSFERT_PDV' | 'ENLEVEMENT_DEDIE'

export interface Tour {
  id: number
  date: string
  code: string
  vehicle_type?: VehicleType
  capacity_eqp?: number
  contract_id?: number | null
  departure_time?: string
  return_time?: string
  total_km?: number
  total_duration_minutes?: number
  total_eqp?: number
  total_cost?: number
  total_weight_kg?: number
  status: TourStatus
  base_id: number
  delivery_date?: string | null
  temperature_type?: TemperatureType
  is_pickup_tour?: boolean
  tour_type?: TourType
  destination?: string | null
  supplier_id?: number | null  // Fournisseur cible (enlèvement dédié)
  bypass_support_rules?: boolean
  priority?: number | null  // Priorité manuelle d'ordonnancement (1..n)
  stops: TourStop[]
  driver_name?: string
  driver_code_infolog?: string | null  // Code chauffeur Infolog (export WMS)
  driver_arrival_time?: string
  loading_end_time?: string
  barrier_exit_time?: string
  barrier_entry_time?: string
  km_departure?: number | null
  km_return?: number | null
  remarks?: string
  loader_code?: string
  loader_name?: string
  trailer_number?: string
  dock_door_number?: string
  trailer_ready_time?: string
  eqp_loaded?: number
  departure_signal_time?: string
  trailer_ready_temp?: number | null
  loading_end_temp?: number | null
  wms_tour_code?: string
  driver_user_id?: number | null
  device_assignment_id?: number | null
  actual_return_time?: string | null
  vehicle_id?: number | null
  tractor_id?: number | null
}

export interface Loader {
  id: number
  code: string
  name: string
  base_id: number
}

export interface BaseDriver {
  id: number
  last_name: string
  first_name: string
  code_infolog: string
  status: string
  base_id: number
  phone: string | null
  email: string | null
  notes: string | null
}

export interface WaybillStop {
  sequence: number
  pdv_code: string
  pdv_name: string
  address: string
  postal_code: string
  city: string
  eqp_count: number
  weight_kg: number
  temperature_classes: string[]
  arrival_time?: string
  departure_time?: string
  pickup_cardboard: boolean
  pickup_containers: boolean
  pickup_returns: boolean
  pickup_consignment: boolean
}

export type CMRStatus = 'DRAFT' | 'ISSUED' | 'DELIVERED' | 'CANCELLED'

export interface WaybillArchive {
  id: number
  cmr_number: string
  tour_id: number
  region_id: number
  status: CMRStatus
  snapshot_json?: string | null
  establishment_place?: string | null
  establishment_date?: string | null
  issued_at?: string | null
  issued_by_id?: number | null
  attached_documents?: string | null
  sender_instructions?: string | null
  payment_instructions?: string | null
  cash_on_delivery?: string | null
  reservations?: string | null
  special_agreements?: string | null
  sender_signed_at?: string | null
  carrier_signed_at?: string | null
  recipient_signed_at?: string | null
  recipient_name?: string | null
  delivery_remarks?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface WaybillData {
  tour_id: number
  tour_code: string
  date: string
  delivery_date?: string | null
  dispatch_date?: string | null
  dispatch_time?: string | null
  departure_time?: string
  return_time?: string
  driver_name?: string
  trailer_number?: string | null
  dock_door_number?: string | null
  remarks?: string
  vehicle_license_plate?: string | null
  tractor_license_plate?: string | null
  base: {
    code: string
    name: string
    address: string
    postal_code: string
    city: string
  } | null
  contract: {
    code: string
    transporter_name: string
    vehicle_code?: string
    vehicle_name?: string
    temperature_type?: string
    vehicle_type?: string
    capacity_weight_kg?: number
    carrier_address?: string
    carrier_postal_code?: string
    carrier_city?: string
    carrier_country?: string
    carrier_transport_license?: string
    carrier_vat_number?: string
    carrier_siren?: string
    carrier_phone?: string
  } | null
  cmr_archive?: {
    id: number
    cmr_number: string
    status: CMRStatus
    issued_at?: string | null
  } | null
  stops: WaybillStop[]
  total_eqp: number
  total_weight_kg: number
}

/* Capacité par défaut selon le type de véhicule (en EQC) / Default capacity per vehicle type (in EQC) */
/* Libellés courts des natures de tour (LIVRAISON non affiché) / Tour nature short labels */
export const TOUR_TYPE_LABELS: Record<Exclude<TourType, 'LIVRAISON'>, string> = {
  ENLEVEMENT: 'Enlèvement',
  VIDANGES: 'Vidanges',
  DEPLACEMENT_BASE: 'Déplacement',
  GARAGE: 'Garage',
  TRANSFERT_PDV: 'Transfert PDV',
  ENLEVEMENT_DEDIE: 'Enlèvement dédié',
}

/* ── Tickets (board transparent) ── */
export type TicketType = 'BUG' | 'FEATURE' | 'QUESTION' | 'OTHER'
export type TicketStatus = 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'REJECTED'
export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface TicketComment {
  id: number
  user_id?: number | null
  user_name?: string | null
  body: string
  is_system: boolean
  created_at?: string | null
}

export interface TicketPhoto {
  id: number
  ticket_id: number
  filename: string
  file_size?: number | null
  mime_type?: string | null
  uploaded_at?: string | null
}

export interface Ticket {
  id: number
  ticket_type: TicketType
  status: TicketStatus
  priority: TicketPriority
  title: string
  description?: string | null
  context?: string | null
  created_by_user_id?: number | null
  created_by_name?: string | null
  created_at?: string | null
  updated_at?: string | null
  comment_count?: number
  photo_count?: number
  comments?: TicketComment[]
  photos?: TicketPhoto[]
}

export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  BUG: 'Bug', FEATURE: 'Évolution', QUESTION: 'Question', OTHER: 'Autre',
}
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'Ouvert', ACKNOWLEDGED: 'Pris en compte', IN_PROGRESS: 'En cours',
  RESOLVED: 'Résolu', CLOSED: 'Clôturé', REJECTED: 'Refusé',
}
export const TICKET_STATUS_COLORS: Record<TicketStatus, string> = {
  OPEN: '#f97316', ACKNOWLEDGED: '#3b82f6', IN_PROGRESS: '#a855f7',
  RESOLVED: '#22c55e', CLOSED: '#6b7280', REJECTED: '#ef4444',
}
export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  LOW: 'Basse', MEDIUM: 'Moyenne', HIGH: 'Haute', CRITICAL: 'Critique',
}

export const VEHICLE_TYPE_DEFAULTS: Record<VehicleType, { label: string; capacity_eqp: number }> = {
  SEMI: { label: 'Semi-remorque', capacity_eqp: 54 },
  SEMI_COURTE: { label: 'Semi courte', capacity_eqp: 44 },
  PORTEUR: { label: 'Porteur', capacity_eqp: 33 },
  PORTEUR_SURBAISSE: { label: 'Porteur surbaissé', capacity_eqp: 33 },
  PORTEUR_REMORQUE: { label: 'Porteur + Remorque', capacity_eqp: 43 },
  // CITY n'est plus proposé à la saisie (#65) — voir SELECTABLE_VEHICLE_TYPES —
  // mais reste défini : des tournées et des points de vente y font référence.
  CITY: { label: 'City', capacity_eqp: 16 },
  VL: { label: 'VL', capacity_eqp: 8 },
}

/* Gabarits proposés à la SAISIE (#65). CITY est retiré des choix — ce n'est plus
   un de leurs transporteurs — mais conservé dans VEHICLE_TYPE_DEFAULTS pour que
   les tournées et points de vente qui le portent restent lisibles. /
   Vehicle types offered for input: CITY is no longer proposed but stays defined. */
export const SELECTABLE_VEHICLE_TYPES: VehicleType[] =
  (Object.keys(VEHICLE_TYPE_DEFAULTS) as VehicleType[]).filter((vt) => vt !== 'CITY')

/* Couleurs température / Temperature colors */
export const TEMPERATURE_COLORS: Record<TemperatureClass, string> = {
  GEL: '#1e40af',
  FRAIS: '#3b82f6',
  SEC: '#f97316',
}

/* Labels type température / Temperature type labels */
export const TEMPERATURE_TYPE_LABELS: Record<TemperatureType, string> = {
  SEC: 'Sec',
  FRAIS: 'Frais',
  GEL: 'Gel',
  BI_TEMP: 'Bi-temp',
  TRI_TEMP: 'Tri-temp',
}

export interface ContractSchedule {
  id: number
  contract_id: number
  date: string  // YYYY-MM-DD
  is_available: boolean
}

// DIESEL = gasoil, GNV = gaz (partagé avec le parc véhicules)
export type FuelType = 'DIESEL' | 'ESSENCE' | 'GNV' | 'ELECTRIQUE' | 'HYBRIDE'

export interface FuelPrice {
  id: number
  fuel_type: FuelType
  start_date: string
  end_date: string
  price_per_liter: number  // €/L (gasoil) ou €/kg (gaz)
}

export interface KmTaxEntry {
  id: number
  origin_type: string
  origin_id: number
  destination_type: string
  destination_id: number
  tax_per_km: number
  origin_label?: string
  destination_label?: string
}

export interface Contract {
  id: number
  transporter_name: string
  code: string
  fixed_daily_cost?: number
  vacation?: number
  cost_per_km?: number
  cost_per_hour?: number
  billing_type?: number
  daily_cost?: number
  trailer_cost?: number
  ha_cost?: number
  prime_saturday?: number
  prime_sunday_holiday?: number
  fuel_type?: FuelType
  min_hours_per_day?: number
  min_km_per_day?: number
  consumption_coefficient?: number
  start_date?: string
  end_date?: string
  region_id: number
  // Champs véhicule / Vehicle fields
  vehicle_code?: string
  vehicle_name?: string
  temperature_type?: TemperatureType
  vehicle_type?: VehicleType
  capacity_eqp?: number
  capacity_weight_kg?: number
  has_tailgate?: boolean
  tailgate_type?: TailgateType
  provides_tractor?: boolean | null
  provides_trailer?: boolean | null
  /** Qui fournit la remorque : transporteur (presté), CMRO (mixte), ou les deux
   *  selon la tournée (#41). / Who supplies the trailer. */
  trailer_supply?: 'CARRIER' | 'CMRO' | 'BOTH' | null
  schedules?: ContractSchedule[]
  carrier_id?: number
  carrier?: Carrier
}

export interface DistanceEntry {
  id: number
  origin_type: string
  origin_id: number
  destination_type: string
  destination_id: number
  distance_km: number
  duration_minutes: number
  origin_label?: string
  destination_label?: string
}

export interface Parameter {
  id: number
  key: string
  value: string
  value_type: string
  region_id?: number
  effective_date?: string
  end_date?: string
}

/* Auth & RBAC types */
export interface Permission {
  id: number
  resource: string
  action: string
}

export interface Role {
  id: number
  name: string
  description?: string
  permissions: Permission[]
  created_at: string
}

export interface UserAccount {
  id: number
  username: string
  email: string
  is_active: boolean
  is_superadmin: boolean
  tenant_id?: number | null
  pdv_id?: number | null
  badge_code?: string
  roles: { id: number; name: string }[]
  regions: { id: number; name: string }[]
  created_at: string
  updated_at: string
}

export interface Tenant {
  id: number
  code: string
  name: string
  is_active: boolean
}

/* ─── Mobile / Tracking types ─── */

export interface MobileDevice {
  id: number
  device_identifier: string | null
  friendly_name?: string
  imei?: string | null
  registration_code: string
  base_id?: number | null
  pdv_id?: number | null
  is_active: boolean
  registered_at?: string | null
  app_version?: string | null
  app_build?: number | null
  os_version?: string | null
  last_seen_at?: string | null
  profile?: string | null
  allowed_features?: string | null
  control_mode?: boolean | null
}

export interface DeviceAssignment {
  id: number
  device_id: number
  user_id: number
  tour_id: number
  date: string
  driver_name?: string | null
  assigned_at?: string
  returned_at?: string
}

export interface GPSPosition {
  id: number
  device_id: number
  tour_id: number
  latitude: number
  longitude: number
  accuracy?: number
  speed?: number
  timestamp: string
}

export interface DriverPosition {
  tour_id: number
  tour_code: string
  driver_name?: string
  latitude: number
  longitude: number
  speed?: number
  accuracy?: number
  timestamp: string
  stops_total: number
  stops_delivered: number
}

export interface ActiveTourStop {
  stop_id: number
  sequence_order: number
  delivery_status: string
  arrival_time?: string
  eqp_count: number
  actual_arrival_time?: string
  actual_departure_time?: string
  pdv_code?: string
  pdv_name?: string
  pdv_city?: string
  pdv_latitude?: number
  pdv_longitude?: number
  pdv_delivery_window_start?: string
  pdv_delivery_window_end?: string
}

export interface ActiveTour {
  tour_id: number
  tour_code: string
  driver_name?: string
  departure_time?: string
  stops: ActiveTourStop[]
}

export interface DeliveryAlert {
  id: number
  tour_id: number
  tour_stop_id?: number | null
  alert_type: string
  severity: string
  message?: string
  created_at: string
  acknowledged_at?: string | null
  acknowledged_by?: number | null
  device_id?: number | null
}

/* ─── Pickup / Container return types ─── */

export interface SupportType {
  id: number
  code: string
  short_code?: string | null
  name: string
  unit_quantity: number
  unit_label?: string | null
  is_active: boolean
  image_path?: string | null
  // Valeur consigne / Consignment value
  unit_value?: number | null
  content_item_label?: string | null
  content_items_per_unit?: number | null
  content_item_value?: number | null
  supplier_plant?: string | null
  supplier_id?: number | null
  alert_threshold?: number | null
  is_combi?: boolean
}

export type PickupTypeEnum = 'CONTAINER' | 'MERCHANDISE' | 'CARDBOARD' | 'CONSIGNMENT'
export type PickupStatusEnum = 'REQUESTED' | 'PLANNED' | 'PICKED_UP' | 'RECEIVED' | 'CANCELLED'
export type LabelStatusEnum = 'PENDING' | 'PLANNED' | 'PICKED_UP' | 'RECEIVED' | 'CANCELLED'

export interface PickupLabel {
  id: number
  pickup_request_id: number
  label_code: string
  sequence_number: number
  status: LabelStatusEnum
  tour_stop_id?: number | null
  picked_up_at?: string | null
  picked_up_device_id?: number | null
  received_at?: string | null
  received_device_id?: number | null
}

export interface PickupRequest {
  id: number
  pdv_id: number
  support_type_id: number
  quantity: number
  availability_date: string
  pickup_type: PickupTypeEnum
  status: PickupStatusEnum
  requested_at?: string | null
  requested_by_user_id?: number | null
  notes?: string | null
  // Consigne / Consignment
  with_content?: boolean
  declared_unit_value?: number | null
  declared_unit_quantity?: number | null
  declared_content_item_value?: number | null
  declared_content_items_per_unit?: number | null
  total_declared_value?: number | null
  print_count?: number
  // Compteurs labels / Label counters
  total_labels?: number
  pending_count?: number
  picked_up_count?: number
  received_count?: number
  // Combi : nb reel scanne (fixe a la cloture chauffeur) / Combi actual scanned at closure
  actual_picked_quantity?: number | null
  // Relations
  pdv?: { id: number; code: string; name: string } | null
  support_type?: SupportType | null
  labels?: PickupLabel[]
}

export interface PdvDeliveryEntry {
  pdv_id: number
  pdv_code: string
  pdv_name: string
  delivery_date: string
  tour_code: string
  tour_id: number
  departure_time: string
  arrival_time: string
  eqp_count: number
  temperature_classes: TemperatureClass[]
  tour_status: TourStatus
  base_code: string
  base_name: string
}

export interface PdvPickupSummary {
  pdv_id: number
  pdv_code: string
  pdv_name: string
  pending_count: number
  requests: PickupRequest[]
}

/* ─── Reprises fournisseur / Supplier pickup types ─── */

export type SupplierPickupStatus = 'DRAFT' | 'SENT' | 'CONFIRMED' | 'PICKED_UP'

export interface SupplierPickupLine {
  id: number
  request_id: number
  support_type_id: number
  palette_count: number
  unit_count?: number | null
  notes?: string | null
  support_type_name?: string | null
  support_type_code?: string | null
}

export interface SupplierPickupRequest {
  id: number
  base_id: number
  supplier_id: number
  status: SupplierPickupStatus
  notes?: string | null
  created_by_user_id?: number | null
  created_at: string
  sent_at?: string | null
  confirmed_at?: string | null
  picked_up_at?: string | null
  supplier?: { id: number; code: string; name: string; email?: string | null } | null
  base?: { id: number; code?: string | null; name: string } | null
  lines: SupplierPickupLine[]
  created_by_username?: string | null
}

export interface StockAlert {
  base_id: number
  base_name: string
  support_type_id: number
  support_type_name: string
  support_type_code: string
  current_stock: number
  alert_threshold: number
  supplier_id?: number | null
  supplier_name?: string | null
}

/* ─── Manifeste WMS / WMS Manifest types ─── */

export interface ManifestLine {
  id: number
  pdv_code: string
  support_number: string
  support_label?: string
  eqc: number
  nb_colis: number
  scanned: boolean
  scanned_at_stop_id?: number
  scanned_at?: string
}

export interface ManifestImportResult {
  created: number
  skipped: number
  total_rows: number
  errors: string[]
}

/* ─── KPI Ponctualité / Punctuality KPI types ─── */

export interface PunctualityMetrics {
  on_time: number
  late: number
  no_scan: number
  pct: number
}

export interface PunctualityKpiResponse {
  summary: {
    total_stops: number
    with_deadline: number
    cdc: PunctualityMetrics
    operational: PunctualityMetrics
  }
  by_activity: Record<string, {
    total: number
    cdc: PunctualityMetrics
    operational: PunctualityMetrics
  }>
  by_date: { date: string; total: number; cdc_pct: number; operational_pct: number }[]
  by_pdv: { pdv_id: number; pdv_code: string; pdv_name: string; total: number;
            cdc_pct: number; operational_pct: number }[]
}

/* ─── SurchargeType ─── */

export interface SurchargeType {
  id: number
  code: string
  label: string
  is_active: boolean
}

/* ─── Fleet & Vehicle Management ─── */

export type FleetVehicleType = 'TRACTEUR' | 'SEMI_REMORQUE' | 'PORTEUR' | 'PORTEUR_SURBAISSE' | 'REMORQUE' | 'VL' | 'SEMI' | 'PORTEUR_REMORQUE' | 'CITY'
export type VehicleStatusType = 'ACTIVE' | 'MAINTENANCE' | 'OUT_OF_SERVICE' | 'DISPOSED'
export type FuelTypeEnum = 'DIESEL' | 'ESSENCE' | 'GNV' | 'ELECTRIQUE' | 'HYBRIDE'
export type OwnershipType = 'OWNED' | 'LEASED' | 'RENTED'

export interface Vehicle {
  id: number
  code: string
  name?: string
  license_plate?: string
  vin?: string
  brand?: string
  model?: string
  fleet_vehicle_type: FleetVehicleType
  status: VehicleStatusType
  fuel_type?: FuelTypeEnum
  temperature_type?: TemperatureType
  capacity_eqp?: number
  capacity_weight_kg?: number
  has_tailgate: boolean
  tailgate_type?: string
  first_registration_date?: string
  acquisition_date?: string
  disposal_date?: string
  current_km?: number
  last_km_update?: string
  ownership_type?: OwnershipType
  lessor_name?: string
  lease_start_date?: string
  lease_end_date?: string
  monthly_lease_cost?: number
  lease_contract_ref?: string
  purchase_price?: number
  depreciation_years?: number
  residual_value?: number
  insurance_company?: string
  insurance_policy_number?: string
  insurance_start_date?: string
  insurance_end_date?: string
  insurance_annual_cost?: number
  last_technical_inspection_date?: string
  next_technical_inspection_date?: string
  tachograph_type?: string
  tachograph_next_calibration?: string
  region_id?: number
  notes?: string
  qr_code?: string
}

export interface VehicleSummary {
  id: number
  code: string
  name?: string
  license_plate?: string
  fleet_vehicle_type: FleetVehicleType
  status: VehicleStatusType
  qr_code?: string
}

// Mode d'affectation dans l'ordonnancement / Assignment mode in scheduling
export type AssignmentMode = 'preste' | 'propre' | 'mixte'

// Véhicule propre disponible pour l'ordonnancement / Own fleet vehicle available for scheduling
export interface AvailableVehicle {
  id: number
  code: string
  license_plate?: string
  fleet_vehicle_type: FleetVehicleType
  temperature_type?: TemperatureType
  capacity_eqp?: number
  has_tailgate: boolean
  tailgate_type?: TailgateType
  is_tractor: boolean
  label: string
}

export interface InspectionTemplate {
  id: number
  label: string
  description?: string
  category: string
  applicable_vehicle_types?: string
  is_critical: boolean
  requires_photo: boolean
  display_order: number
  is_active: boolean
}

export interface InspectionItem {
  id: number
  inspection_id: number
  template_id?: number
  label: string
  category: string
  result: string
  comment?: string
  is_critical: boolean
}

export interface InspectionPhoto {
  id: number
  inspection_id: number
  item_id?: number
  filename: string
  file_size?: number
  mime_type?: string
  uploaded_at: string
}

export interface VehicleInspection {
  id: number
  vehicle_id: number
  tour_id?: number
  device_id?: number
  inspection_type: string
  status: string
  driver_name?: string
  km_at_inspection?: number
  latitude?: number
  longitude?: number
  started_at: string
  completed_at?: string
  remarks?: string
  has_critical_defect: boolean
  items: InspectionItem[]
  photos: InspectionPhoto[]
  vehicle_code?: string
  vehicle_name?: string
}

export interface MaintenanceRecord {
  id: number
  vehicle_id: number
  maintenance_type: string
  status: string
  description?: string
  provider_name?: string
  scheduled_date?: string
  scheduled_km?: number
  completed_date?: string
  km_at_service?: number
  cost_parts?: number
  cost_labor?: number
  cost_total?: number
  invoice_ref?: string
  inspection_id?: number
  notes?: string
  created_at?: string
}

export interface MaintenanceScheduleRule {
  id: number
  label: string
  maintenance_type: string
  applicable_vehicle_types?: string
  interval_km?: number
  interval_months?: number
  is_active: boolean
}

export interface FuelEntry {
  id: number
  vehicle_id: number
  date: string
  km_at_fill?: number
  liters: number
  price_per_liter?: number
  total_cost?: number
  is_full_tank: boolean
  station_name?: string
  driver_name?: string
  notes?: string
}

export interface VehicleModificationEntry {
  id: number
  vehicle_id: number
  date: string
  description: string
  cost?: number
  provider_name?: string
  invoice_ref?: string
  notes?: string
}

export interface VehicleCostEntry {
  id: number
  vehicle_id: number
  category: string
  date: string
  description?: string
  amount: number
  invoice_ref?: string
  notes?: string
}

export interface VehicleTCOItem {
  vehicle_id: number
  vehicle_code: string
  vehicle_name?: string
  fleet_vehicle_type: string
  ownership_type?: string
  lease_cost: number
  depreciation_cost: number
  maintenance_cost: number
  fuel_cost: number
  modification_cost: number
  other_costs: number
  total_cost: number
  total_km: number
  cost_per_km?: number
}

export interface FleetDashboard {
  vehicles: VehicleTCOItem[]
  total_fleet_cost: number
  total_fleet_km: number
  avg_cost_per_km?: number
}

/* ─── Driver Declarations ─── */

export interface DeclarationPhoto {
  id: number
  declaration_id: number
  filename: string
  file_size?: number
  mime_type?: string
  uploaded_at: string
}

export interface Declaration {
  id: number
  device_id: number
  tour_id?: number | null
  tour_stop_id?: number | null
  declaration_type: string
  description?: string | null
  latitude?: number | null
  longitude?: number | null
  accuracy?: number | null
  driver_name?: string | null
  created_at: string
  photos: DeclarationPhoto[]
}

/* ─── Consignment Tracking (Zèbre) ─── */

export interface ConsignmentMovement {
  id: number
  batch_id: string
  pdv_code: string
  pdv_name?: string | null
  base: string
  waybill_number?: number | null
  flux_date: string
  consignment_code: string
  consignment_label?: string | null
  consignment_type?: string | null
  quantity: number
  value?: number | null
  flux_type: string
  unit_value?: number | null
  year?: number | null
  month?: number | null
}

export interface ConsignmentBalance {
  pdv_code: string
  pdv_name?: string | null
  consignment_code: string
  consignment_label?: string | null
  total_quantity: number
  total_value?: number | null
}

export interface ConsignmentImportResult {
  created: number
  skipped: number
  total_rows: number
  errors: string[]
  batch_id: string
}

export interface ConsignmentImportInfo {
  batch_id?: string | null
  total_rows: number
  imported_at?: string | null
}

export interface ConsignmentFilters {
  bases: string[]
  consignment_types: string[]
  consignment_codes: string[]
  flux_types: string[]
}

// --- Stock contenants PDV / PDV container stock ---
export interface PdvStockDetail {
  pdv_id: number
  pdv_code: string
  pdv_name: string
  support_type_id: number
  support_type_code: string
  support_type_name: string
  current_stock: number
  puo: number | null
  unit_value: number | null
  last_inventory_at: string | null
  last_inventoried_by: string | null
}

export interface PuoOverageItem {
  pdv_id: number
  pdv_code: string
  pdv_name: string
  support_type_id: number
  support_type_code: string
  support_type_name: string
  current_stock: number
  puo: number
  overage: number
  unit_value: number
  overage_value: number
}

export interface PuoOverageReport {
  items: PuoOverageItem[]
  total_overage_units: number
  total_overage_value: number
  pdv_count: number
}

// --- Facturation GIC / GIC billing ---
export interface GicInvoiceLine {
  id: number
  pdv_id: number
  pdv_code: string
  pdv_name: string
  support_type_id: number
  support_type_code: string
  support_type_name: string
  current_stock: number
  puo: number
  overage: number
  unit_value: number
  overage_value: number
}

export interface GicInvoice {
  id: number
  period_label: string
  period_start: string
  period_end: string
  total_overage_units: number
  total_overage_value: number
  pdv_count: number
  line_count: number
  status: string
  generated_at: string
  generated_by?: string
  notes?: string
  base_id?: number
  lines?: GicInvoiceLine[]
}

export interface PdvInventoryRecord {
  id: number
  pdv_id: number
  support_type_id: number
  quantity: number
  inventoried_at: string
  inventoried_by: string | null
}

// --- Stock contenants base / Base container stock ---
export interface BaseStockDetail {
  id: number
  base_id: number
  base_code: string
  base_name: string
  zone_id?: number | null
  zone_name?: string | null
  support_type_id: number
  support_type_code: string
  support_type_name: string
  unit_quantity: number
  unit_label: string | null
  current_stock: number
  last_updated_at: string | null
}

export type BaseMovementTypeEnum = 'RECEIVED_FROM_PDV' | 'DELIVERY_PREP' | 'SUPPLIER_RETURN' | 'INVENTORY_ADJUSTMENT' | 'BASE_INVENTORY'

export interface BaseMovementRecord {
  id: number
  base_id: number
  base_name: string
  zone_id?: number | null
  zone_name?: string | null
  support_type_id: number
  support_type_code: string
  support_type_name: string
  movement_type: BaseMovementTypeEnum
  inventory_type?: string | null
  quantity: number
  reference: string | null
  timestamp: string
  notes: string | null
}
