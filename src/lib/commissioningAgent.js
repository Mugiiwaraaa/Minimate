/* --- commissioningAgent.js ---
   Thin client for the local `commissioning_agent.py` HTTP API (see
   D:\K&P Projects - 25-26 Fahad\KMC\kmc_commission\commissioning_agent.py).

   Why this exists: the browser can't open a raw BACnet/IP UDP socket or talk to an RS-485
   serial adapter. A small Python process running on the SAME laptop the technician has
   physically connected to the DDC controller / RS-485 loop does the real protocol work and
   talks to this project's own Supabase directly. This module just calls it over loopback HTTP.

   The agent must be running on the commissioning laptop:
     python commissioning_agent.py --port 8765
   If it isn't reachable, every call here rejects with a clear "agent not running" message —
   callers should show that inline, not crash. */

var BASE = 'http://127.0.0.1:8765'

function req(method, path, body) {
  return fetch(BASE + path, {
    method: method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(function() {
    throw new Error('Cannot reach the local commissioning agent at ' + BASE + '. Is commissioning_agent.py running on this laptop?')
  }).then(function(r) {
    return r.text().then(function(text) {
      var data = {}
      try { data = text ? JSON.parse(text) : {} } catch (e) { /* non-JSON error page, fall through */ }
      if (!r.ok) throw new Error(data.error || ('Agent HTTP ' + r.status))
      return data
    })
  })
}

export function health() { return req('GET', '/health') }
export function serialPorts() { return req('GET', '/serial-ports') }

export function bacnetDiscover(body) { return req('POST', '/bacnet/discover', body) }
export function bacnetVerify(body) { return req('POST', '/bacnet/verify', body) }
export function bacnetWrite(body) { return req('POST', '/bacnet/write', body) }

export function modbusPreflight(body) { return req('POST', '/modbus/preflight', body) }
export function modbusScan(body) { return req('POST', '/modbus/scan', body) }
export function modbusVerify(body) { return req('POST', '/modbus/verify', body) }
export function modbusGenerateConfig(body) { return req('POST', '/modbus/generate-config', body) }

/* Two independent ways to commission a gateway's own side — not mutually exclusive:
   modbusGenerateConfig() above produces a config.csv for a real FieldServer box (loaded on site,
   manually). These run THIS toolkit as the gateway instead — no physical FieldServer needed. */
export function modbusGatewayStart(body) { return req('POST', '/modbus/gateway/start', body) }
export function modbusGatewayStatus(body) { return req('POST', '/modbus/gateway/status', body) }
export function modbusGatewayStop(body) { return req('POST', '/modbus/gateway/stop', body) }

/* Template library — config generation needs exactly one ACTIVE template per device_type. Multiple
   templates can exist per device_type (different vendors, unverified drafts); the user picks which
   is active, never guessed automatically. */
export function modbusTemplatesList() { return req('GET', '/modbus/templates') }
export function modbusTemplatesActivate(body) { return req('POST', '/modbus/templates/activate', body) }
export function modbusTemplatesImportConfigCsv(body) { return req('POST', '/modbus/templates/import-config-csv', body) }
export function modbusTemplatesImportRegisterSheet(body) { return req('POST', '/modbus/templates/import-register-sheet', body) }

/* Local BACnet interface (e.g. "192.168.1.100/24:47809") is a laptop/site setting, not
   project data — persisted per-browser, not synced to Supabase. */
var LOCAL_ADDR_KEY = 'kmc_local_bacnet_iface'
export function getLocalAddress() { return localStorage.getItem(LOCAL_ADDR_KEY) || '' }
export function setLocalAddress(v) { localStorage.setItem(LOCAL_ADDR_KEY, v || '') }

/* Mirrors modbus_schedule.gateway_key() (Python) exactly, so a gateway_key computed here always
   matches what read_minimate_schedule() computed server-side for the same loop. Only meaningful
   once a loop has a non-blank `gateway` field — an unassigned loop's schedule rows key on the raw
   loop id instead (see minimate_bridge.read_minimate_schedule), so pass loop.id in that case. */
export function gatewayKeyFor(raw) {
  var n = (raw || '').replace(/[^0-9A-Za-z]+/g, '')
  var m = n.match(/(\d+)$/)
  return m ? ('GW-' + m[1]) : (n || 'GW-UNKNOWN')
}
