/* Application principale / Main application with routing */

import { Routes, Route } from 'react-router-dom'
import { Suspense, lazy } from 'react'
import { MainLayout } from './components/layout/MainLayout'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { DefaultRedirect } from './components/auth/DefaultRedirect'
import { ChunkErrorBoundary } from './components/ErrorBoundary'

const Login = lazy(() => import('./pages/Login'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const CountryRegion = lazy(() => import('./pages/CountryRegion'))
const BaseManagement = lazy(() => import('./pages/BaseManagement'))
const PdvManagement = lazy(() => import('./pages/PdvManagement'))
const SupplierManagement = lazy(() => import('./pages/SupplierManagement'))
const VolumeManagement = lazy(() => import('./pages/VolumeManagement'))
const ContractManagement = lazy(() => import('./pages/ContractManagement'))
const DistanceMatrix = lazy(() => import('./pages/DistanceMatrix'))
const FuelPrices = lazy(() => import('./pages/FuelPrices'))
const KmTax = lazy(() => import('./pages/KmTax'))
const BaseActivityManagement = lazy(() => import('./pages/BaseActivityManagement'))
const ParameterSettings = lazy(() => import('./pages/ParameterSettings'))
const TourPlanning = lazy(() => import('./pages/TourPlanning'))
const TourHistory = lazy(() => import('./pages/TourHistory'))
const TransporterSummary = lazy(() => import('./pages/TransporterSummary'))
const LoaderManagement = lazy(() => import('./pages/LoaderManagement'))
const BaseDriverManagement = lazy(() => import('./pages/BaseDriverManagement'))
const Operations = lazy(() => import('./pages/Operations'))
const OperationalAlerts = lazy(() => import('./pages/OperationalAlerts'))
const Tickets = lazy(() => import('./pages/Tickets'))
const GuardPost = lazy(() => import('./pages/GuardPost'))
const GuardPostDelivery = lazy(() => import('./pages/GuardPostDelivery'))
const SupplierPortal = lazy(() => import('./pages/SupplierPortal'))
const DriverKiosk = lazy(() => import('./pages/DriverKiosk'))
const ContainerDashboard = lazy(() => import('./pages/ContainerDashboard'))
const ContainerMap = lazy(() => import('./pages/ContainerMap'))
const GicBilling = lazy(() => import('./pages/GicBilling'))
const UserManagement = lazy(() => import('./pages/admin/UserManagement'))
const RoleManagement = lazy(() => import('./pages/admin/RoleManagement'))
const AuditLog = lazy(() => import('./pages/AuditLog'))
const Help = lazy(() => import('./pages/Help'))
const DeviceManagement = lazy(() => import('./pages/DeviceManagement'))
const Tracking = lazy(() => import('./pages/Tracking'))
const SupportScanTrace = lazy(() => import('./pages/SupportScanTrace'))
const SupportTypes = lazy(() => import('./pages/SupportTypes'))
const BaseSupportRules = lazy(() => import('./pages/BaseSupportRules'))
const PdvPickupRequests = lazy(() => import('./pages/PdvPickupRequests'))
const PdvCrateRequests = lazy(() => import('./pages/PdvCrateRequests'))
const CrateManagement = lazy(() => import('./pages/CrateManagement'))
const BaseReception = lazy(() => import('./pages/BaseReception'))
const PdvDeliverySchedule = lazy(() => import('./pages/PdvDeliverySchedule'))
const SurchargeTypes = lazy(() => import('./pages/SurchargeTypes'))
const AideDecision = lazy(() => import('./pages/AideDecision'))
const DetachedMap = lazy(() => import('./pages/DetachedMap'))
const DetachedGantt = lazy(() => import('./pages/DetachedGantt'))
const DetachedTourList = lazy(() => import('./pages/DetachedTourList'))
const PhoneSetupGuide = lazy(() => import('./pages/PhoneSetupGuide'))
const VehicleManagement = lazy(() => import('./pages/VehicleManagement'))
const InspectionManagement = lazy(() => import('./pages/InspectionManagement'))
const FleetManagement = lazy(() => import('./pages/FleetManagement'))
const ReportDaily = lazy(() => import('./pages/ReportDaily'))
const ReportDriver = lazy(() => import('./pages/ReportDriver'))
const ReportPdv = lazy(() => import('./pages/ReportPdv'))
const ReportVehicle = lazy(() => import('./pages/ReportVehicle'))
const DeclarationManagement = lazy(() => import('./pages/DeclarationManagement'))
const CarrierManagement = lazy(() => import('./pages/CarrierManagement'))
const ConsignmentTracking = lazy(() => import('./pages/ConsignmentTracking'))
const WaybillRegistry = lazy(() => import('./pages/WaybillRegistry'))
const PdvStock = lazy(() => import('./pages/PdvStock'))
const BaseContainerStock = lazy(() => import('./pages/BaseContainerStock'))
const SupplierPickupRequests = lazy(() => import('./pages/SupplierPickupRequests'))
const CollectionRequests = lazy(() => import('./pages/CollectionRequests'))
const TemperatureControl = lazy(() => import('./pages/TemperatureControl'))
const CnufTemperatureManagement = lazy(() => import('./pages/CnufTemperatureManagement'))
const ReceptionBookingPage = lazy(() => import('./pages/ReceptionBooking'))
const BeerConsignments = lazy(() => import('./pages/BeerConsignments'))
const ContainerAnomalies = lazy(() => import('./pages/ContainerAnomalies'))
const ContainerPrep = lazy(() => import('./pages/ContainerPrep'))
const BottleSorting = lazy(() => import('./pages/BottleSorting'))
const ContainerReport = lazy(() => import('./pages/ContainerReport'))
const BookingGuide = lazy(() => import('./pages/BookingGuide'))

function Loading() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-lg" style={{ color: 'var(--text-muted)' }}>Chargement...</div>
    </div>
  )
}

export default function App() {
  return (
    <ChunkErrorBoundary>
      <Routes>
        <Route path="/login" element={<Suspense fallback={<Loading />}><Login /></Suspense>} />
        <Route path="/reset-password" element={<Suspense fallback={<Loading />}><ResetPassword /></Suspense>} />
        <Route path="/supplier-portal" element={<Suspense fallback={<Loading />}><SupplierPortal /></Suspense>} />
        <Route path="/driver-kiosk" element={<Suspense fallback={<Loading />}><DriverKiosk /></Suspense>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/map-detached" element={<Suspense fallback={<Loading />}><DetachedMap /></Suspense>} />
          <Route path="/gantt-detached" element={<Suspense fallback={<Loading />}><DetachedGantt /></Suspense>} />
          <Route path="/tour-list-detached" element={<Suspense fallback={<Loading />}><DetachedTourList /></Suspense>} />
          <Route element={<MainLayout />}>
            <Route path="/" element={<DefaultRedirect><Dashboard /></DefaultRedirect>} />
            <Route path="/countries" element={<CountryRegion />} />
            <Route path="/bases" element={<BaseManagement />} />
            <Route path="/pdvs" element={<PdvManagement />} />
            <Route path="/suppliers" element={<SupplierManagement />} />
            <Route path="/volumes" element={<VolumeManagement />} />
            <Route path="/contracts" element={<ContractManagement />} />
            <Route path="/distances" element={<DistanceMatrix />} />
            <Route path="/fuel-prices" element={<FuelPrices />} />
            <Route path="/km-tax" element={<KmTax />} />
            <Route path="/base-activities" element={<BaseActivityManagement />} />
            <Route path="/parameters" element={<ParameterSettings />} />
            <Route path="/tour-planning" element={<TourPlanning />} />
            <Route path="/tour-history" element={<TourHistory />} />
            <Route path="/transporter-summary" element={<TransporterSummary />} />
            <Route path="/loaders" element={<LoaderManagement />} />
            <Route path="/base-drivers" element={<BaseDriverManagement />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="/alerts" element={<OperationalAlerts />} />
            <Route path="/tickets" element={<Tickets />} />
            <Route path="/container-dashboard" element={<ContainerDashboard />} />
            <Route path="/container-map" element={<ContainerMap />} />
            <Route path="/gic-billing" element={<GicBilling />} />
            <Route path="/guard-post" element={<GuardPost />} />
            <Route path="/guard-post-delivery" element={<GuardPostDelivery />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/admin/users" element={<UserManagement />} />
            <Route path="/admin/roles" element={<RoleManagement />} />
            <Route path="/devices" element={<DeviceManagement />} />
            <Route path="/tracking" element={<Tracking />} />
            <Route path="/support-scans" element={<SupportScanTrace />} />
            <Route path="/support-types" element={<SupportTypes />} />
            <Route path="/base-support-rules" element={<BaseSupportRules />} />
            <Route path="/pickup-requests" element={<PdvPickupRequests />} />
            <Route path="/crate-requests" element={<PdvCrateRequests />} />
            <Route path="/crate-management" element={<CrateManagement />} />
            <Route path="/base-reception" element={<BaseReception />} />
            <Route path="/surcharge-types" element={<SurchargeTypes />} />
            <Route path="/aide-decision" element={<AideDecision />} />
            <Route path="/pdv-deliveries" element={<PdvDeliverySchedule />} />
            <Route path="/phone-setup" element={<PhoneSetupGuide />} />
            <Route path="/vehicles" element={<VehicleManagement />} />
            <Route path="/inspections" element={<InspectionManagement />} />
            <Route path="/fleet" element={<FleetManagement />} />
            <Route path="/reports/daily" element={<ReportDaily />} />
            <Route path="/reports/driver" element={<ReportDriver />} />
            <Route path="/reports/pdv" element={<ReportPdv />} />
            <Route path="/reports/vehicle" element={<ReportVehicle />} />
            <Route path="/declarations" element={<DeclarationManagement />} />
            <Route path="/carriers" element={<CarrierManagement />} />
            <Route path="/consignments" element={<ConsignmentTracking />} />
            <Route path="/waybill-registry" element={<WaybillRegistry />} />
            <Route path="/pdv-stock" element={<PdvStock />} />
            <Route path="/base-container-stock" element={<BaseContainerStock />} />
            <Route path="/supplier-pickups" element={<SupplierPickupRequests />} />
            <Route path="/collection-requests" element={<CollectionRequests />} />
            <Route path="/temperature" element={<TemperatureControl />} />
            <Route path="/cnuf-temperatures" element={<CnufTemperatureManagement />} />
            <Route path="/reception-booking" element={<ReceptionBookingPage />} />
            <Route path="/beer-consignments" element={<BeerConsignments />} />
            <Route path="/container-anomalies" element={<ContainerAnomalies />} />
            <Route path="/container-prep" element={<ContainerPrep />} />
            <Route path="/bottle-sorting" element={<BottleSorting />} />
            <Route path="/container-report" element={<ContainerReport />} />
            <Route path="/guide-booking" element={<BookingGuide />} />
            <Route path="/help" element={<Help />} />
          </Route>
        </Route>
      </Routes>
    </ChunkErrorBoundary>
  )
}
