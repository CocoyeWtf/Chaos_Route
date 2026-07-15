/* Types TypeScript mobile (sous-ensemble du web) / Mobile TypeScript types */

export interface PickupSummaryItem {
  support_type_code: string
  support_type_name: string
  total_labels: number
  pending_labels: number
}

export interface DriverTourStop {
  id: number
  sequence_order: number
  eqp_count: number
  pdv_code?: string
  pdv_name?: string
  pdv_address?: string
  pdv_city?: string
  pdv_latitude?: number
  pdv_longitude?: number
  delivery_status?: string
  arrival_time?: string
  departure_time?: string
  actual_arrival_time?: string
  actual_departure_time?: string
  pickup_cardboard: boolean
  pickup_containers: boolean
  pickup_returns: boolean
  pickup_consignment: boolean
  scanned_supports_count?: number
  pending_pickup_labels_count?: number
  pickup_summary?: PickupSummaryItem[]
}

export interface PickupLabelMobile {
  id: number
  pickup_request_id: number
  label_code: string
  sequence_number: number
  status: string
  tour_stop_id?: number | null
  picked_up_at?: string | null
  picked_up_device_id?: number | null
  received_at?: string | null
}

export interface SupportScan {
  id: number
  tour_stop_id: number
  barcode: string
  timestamp: string
  expected_at_stop: boolean
  expected_pdv_code?: string
  latitude?: number
  longitude?: number
}

export interface DriverTour {
  id: number
  code: string
  date: string
  delivery_date?: string
  departure_time?: string
  return_time?: string
  total_eqp?: number
  status: string
  base_code?: string
  base_name?: string
  vehicle_code?: string
  vehicle_name?: string
  driver_name?: string
  temperature_type?: string
  stops: DriverTourStop[]
}

export interface AvailableTour {
  id: number
  code: string
  delivery_date?: string
  departure_time?: string
  total_eqp?: number
  stops_count: number
  driver_name?: string
  vehicle_code?: string
}

export type DeclarationType = 'ANOMALY' | 'BREAKAGE' | 'ACCIDENT' | 'VEHICLE_ISSUE' | 'CLIENT_ISSUE' | 'OTHER'

export interface DriverDeclaration {
  id: number
  device_id: number
  tour_id?: number | null
  tour_stop_id?: number | null
  declaration_type: DeclarationType
  description?: string | null
  latitude?: number | null
  longitude?: number | null
  accuracy?: number | null
  driver_name?: string | null
  created_at: string
  photos: DeclarationPhoto[]
}

export interface DeclarationPhoto {
  id: number
  declaration_id: number
  filename: string
  file_size?: number | null
  mime_type?: string | null
  uploaded_at: string
}

/* ─── Inspections vehicules / Vehicle inspections ─── */

export type InspectionItemResult = 'OK' | 'KO' | 'NA' | 'NOT_CHECKED'

export interface InspectionStartItem {
  id: number
  label: string
  category: string
  is_critical: boolean
  requires_photo: boolean
  result: InspectionItemResult
}

export interface InspectionStartResponse {
  inspection_id: number
  items: InspectionStartItem[]
}

export interface InspectionCheckVehicle {
  id: number
  code: string
  name?: string
  fleet_vehicle_type: string
  qr_code?: string
  inspection_done: boolean
  inspection_id?: number
}

export interface InspectionCheckResponse {
  required: boolean
  vehicles: InspectionCheckVehicle[]
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
}

export interface UserMe {
  id: number
  username: string
  email: string
  is_superadmin: boolean
  pdv_id?: number | null
  supplier_id?: number | null
  badge_code?: string | null
}

/* ─── Scanner reprises autonome / Standalone pickup scanner ─── */

export interface StandalonePickupScan {
  label_code: string
  status: string
  picked_up_at: string | null
  pdv_code: string | null
  pdv_name: string | null
  support_type_code: string | null
  support_type_name: string | null
  pickup_type: string | null
  with_content: boolean
  declared_unit_value: number | null
  quantity: number
}

/* ─── Reception base / Base reception scan ─── */

export interface BaseReceiveScan {
  label_code: string
  status: string
  received_at: string | null
  pdv_code: string | null
  pdv_name: string | null
  support_type_code: string | null
  support_type_name: string | null
  pickup_type: string | null
  with_content: boolean
  declared_unit_value: number | null
  quantity: number
}

/* ─── Inventaire PDV / PDV container inventory ─── */

export interface SupportTypeBasic {
  id: number
  code: string
  name: string
  unit_quantity: number
  unit_label?: string
  is_active?: boolean
  is_combi?: boolean
}

export interface InventoryLine {
  support_type_id: number
  quantity: number
}

export interface PdvBasic {
  id: number
  code: string
  name: string
}
