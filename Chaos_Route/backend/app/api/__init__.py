"""Routes API / API routes."""

from fastapi import APIRouter

from app.api import (
    aide_decision,
    audit,
    auth,
    carriers,
    countries,
    regions,
    base_activities,
    bases,
    pdvs,
    suppliers,
    volumes,
    tours,
    contracts,
    distance_matrix,
    fuel_prices,
    km_tax,
    parameters,
    imports,
    exports,
    users,
    roles,
    loaders,
    devices,
    assignments,
    driver,
    tracking,
    ws_tracking,
    support_types,
    pickup_requests,
    kpi,
    surcharge_types,
    surcharges,
    declarations,
    vehicles,
    inspections,
    fleet,
    reports,
    consignments,
    waybill_archives,
    inventory,
    base_container_stock,
    supplier_pickup_requests,
    collection_requests,
    temperature,
    reception_booking,
    sms,
    gdpr,
    cnuf_temperature,
    gic_invoices,
    beer_consignments,
    container_anomalies,
    bottle_sorting,
    container_report,
    control_evidences,
    crate_requests,
    base_support_rules,
    pdv_support_rules,
    base_drivers,
    operational_alerts,
    tickets,
    tenants,
    retention,
)

api_router = APIRouter(prefix="/api")

api_router.include_router(aide_decision.router, prefix="/aide-decision", tags=["aide-decision"])
api_router.include_router(audit.router, prefix="/audit", tags=["audit"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(roles.router, prefix="/roles", tags=["roles"])
api_router.include_router(countries.router, prefix="/countries", tags=["countries"])
api_router.include_router(regions.router, prefix="/regions", tags=["regions"])
api_router.include_router(base_activities.router, prefix="/base-activities", tags=["base-activities"])
api_router.include_router(bases.router, prefix="/bases", tags=["bases"])
api_router.include_router(pdvs.router, prefix="/pdvs", tags=["pdvs"])
api_router.include_router(suppliers.router, prefix="/suppliers", tags=["suppliers"])
api_router.include_router(volumes.router, prefix="/volumes", tags=["volumes"])
api_router.include_router(tours.router, prefix="/tours", tags=["tours"])
api_router.include_router(contracts.router, prefix="/contracts", tags=["contracts"])
api_router.include_router(distance_matrix.router, prefix="/distance-matrix", tags=["distance-matrix"])
api_router.include_router(fuel_prices.router, prefix="/fuel-prices", tags=["fuel-prices"])
api_router.include_router(km_tax.router, prefix="/km-tax", tags=["km-tax"])
api_router.include_router(parameters.router, prefix="/parameters", tags=["parameters"])
api_router.include_router(imports.router, prefix="/imports", tags=["imports"])
api_router.include_router(exports.router, prefix="/exports", tags=["exports"])
api_router.include_router(loaders.router, prefix="/loaders", tags=["loaders"])
api_router.include_router(devices.router, prefix="/devices", tags=["devices"])
api_router.include_router(assignments.router, prefix="/assignments", tags=["assignments"])
api_router.include_router(driver.router, prefix="/driver", tags=["driver"])
api_router.include_router(tracking.router, prefix="/tracking", tags=["tracking"])
api_router.include_router(support_types.router, prefix="/support-types", tags=["support-types"])
api_router.include_router(pickup_requests.router, prefix="/pickup-requests", tags=["pickup-requests"])
api_router.include_router(kpi.router, prefix="/kpi", tags=["KPI"])
api_router.include_router(surcharge_types.router, prefix="/surcharge-types", tags=["surcharge-types"])
api_router.include_router(surcharges.router, prefix="/surcharges", tags=["surcharges"])
api_router.include_router(declarations.router, prefix="/declarations", tags=["declarations"])
api_router.include_router(vehicles.router, prefix="/vehicles", tags=["vehicles"])
api_router.include_router(inspections.router, prefix="/inspections", tags=["inspections"])
api_router.include_router(fleet.router, prefix="/fleet", tags=["fleet"])
api_router.include_router(reports.router, prefix="/reports", tags=["reports"])
api_router.include_router(consignments.router, prefix="/consignments", tags=["consignments"])
api_router.include_router(carriers.router, prefix="/carriers", tags=["carriers"])
api_router.include_router(waybill_archives.router, tags=["waybill-archives"])
api_router.include_router(inventory.router, prefix="/pdv-stock", tags=["pdv-stock"])
api_router.include_router(base_container_stock.router, prefix="/base-container-stock", tags=["base-container-stock"])
api_router.include_router(supplier_pickup_requests.router, prefix="/supplier-pickups", tags=["supplier-pickups"])
api_router.include_router(collection_requests.router, prefix="/collection-requests", tags=["collection-requests"])
api_router.include_router(temperature.router, prefix="/temperature", tags=["temperature"])
api_router.include_router(reception_booking.router, prefix="/reception-booking", tags=["reception-booking"])
api_router.include_router(sms.router, prefix="/sms", tags=["sms"])
api_router.include_router(gdpr.router, prefix="/gdpr", tags=["gdpr"])
api_router.include_router(cnuf_temperature.router, prefix="/cnuf-temperatures", tags=["cnuf-temperatures"])
api_router.include_router(gic_invoices.router, prefix="/gic-invoices", tags=["gic-invoices"])
api_router.include_router(beer_consignments.router, prefix="/beer-consignments", tags=["beer-consignments"])
api_router.include_router(container_anomalies.router, prefix="/container-anomalies", tags=["container-anomalies"])
api_router.include_router(bottle_sorting.router, prefix="/bottle-sorting", tags=["bottle-sorting"])
api_router.include_router(container_report.router, prefix="/container-report", tags=["container-report"])
api_router.include_router(control_evidences.router, prefix="/control-evidences", tags=["control-evidences"])
api_router.include_router(crate_requests.router, prefix="/crate-requests", tags=["crate-requests"])
api_router.include_router(base_support_rules.router, prefix="/base-support-rules", tags=["base-support-rules"])
api_router.include_router(pdv_support_rules.router, prefix="/pdv-support-rules", tags=["pdv-support-rules"])
api_router.include_router(base_drivers.router, prefix="/base-drivers", tags=["base-drivers"])
api_router.include_router(operational_alerts.router, prefix="/alerts", tags=["alerts"])
api_router.include_router(tickets.router, prefix="/tickets", tags=["tickets"])
api_router.include_router(tenants.router, prefix="/tenants", tags=["tenants"])
api_router.include_router(retention.router, prefix="/retention", tags=["retention"])
