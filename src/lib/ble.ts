/**
 * Web Bluetooth heart-rate manager.
 *
 * The PDF concludes Web Bluetooth on desktop Chrome/Edge (and Android) is the
 * pragmatic "no-phone-app" path. This connects to the standard BLE Heart Rate
 * Service (0x180D), subscribes to Heart Rate Measurement (0x2A37), and parses
 * both instantaneous HR and the beat-to-beat R-R intervals that DFA-α1 needs.
 *
 * Works with Polar H10, Garmin HRM-Pro Plus, and any sensor exposing 0x180D —
 * including the Whoop "HR Broadcast" mode noted in the report.
 */

import type { HRSample, DeviceInfo, DeviceStatus } from "../types";

const HR_SERVICE = "heart_rate";
const HR_MEASUREMENT = "heart_rate_measurement";
const BATTERY_SERVICE = "battery_service";
const BATTERY_LEVEL = "battery_level";

export function bluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

type SampleCb = (s: HRSample) => void;
type DeviceCb = (d: DeviceInfo) => void;
type ErrCb = (msg: string) => void;

export class HeartRateBLE {
  private device: BluetoothDevice | null = null;
  private char: BluetoothRemoteGATTCharacteristic | null = null;
  private batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  private info: DeviceInfo | null = null;
  private reconnectTimer: number | null = null;
  private manualDisconnect = false;

  constructor(
    private onSample: SampleCb,
    private onDevice: DeviceCb,
    private onError: ErrCb
  ) {}

  async connect(): Promise<void> {
    if (!bluetoothSupported()) {
      this.onError("Web Bluetooth isn't available in this browser. Use Chrome or Edge on desktop/Android.");
      return;
    }
    this.manualDisconnect = false;
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HR_SERVICE] }],
        optionalServices: [BATTERY_SERVICE, "device_information"],
      });
      this.device = device;
      this.info = {
        id: device.id,
        name: device.name || "HR Sensor",
        status: "connecting",
        battery: null,
        primary: true,
        lastHr: null,
        hasRR: false,
      };
      this.emit();

      device.addEventListener("gattserverdisconnected", this.handleDisconnect);
      await this.openGatt();
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (/cancelled|User cancelled/i.test(msg)) return; // user closed the chooser
      this.onError(msg);
      this.setStatus("disconnected");
    }
  }

  private async openGatt(): Promise<void> {
    if (!this.device?.gatt) throw new Error("No GATT server on device.");
    const server = await this.device.gatt.connect();

    const hrService = await server.getPrimaryService(HR_SERVICE);
    this.char = await hrService.getCharacteristic(HR_MEASUREMENT);
    await this.char.startNotifications();
    this.char.addEventListener("characteristicvaluechanged", this.handleValue);

    // Battery (best-effort)
    void this.readBattery(server);

    this.setStatus("connected");
  }

  private async readBattery(server: BluetoothRemoteGATTServer): Promise<void> {
    try {
      const svc = await server.getPrimaryService(BATTERY_SERVICE);
      const ch = await svc.getCharacteristic(BATTERY_LEVEL);
      const val = await ch.readValue();
      if (val.byteLength > 0 && this.info) {
        this.info.battery = val.getUint8(0);
        this.emit();
      }
      // Clean up a prior subscription (reconnect) before re-subscribing.
      this.batteryChar?.removeEventListener("characteristicvaluechanged", this.handleBattery);
      this.batteryChar = ch;
      await ch.startNotifications();
      ch.addEventListener("characteristicvaluechanged", this.handleBattery);
    } catch {
      /* device has no battery service — fine */
    }
  }

  private handleBattery = (ev: Event) => {
    const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (dv && dv.byteLength > 0 && this.info) {
      this.info.battery = dv.getUint8(0);
      this.emit();
    }
  };

  private handleValue = (ev: Event) => {
    const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!dv) return;
    const sample = parseHeartRate(dv);
    if (!this.info) return;
    this.info.lastHr = sample.hr;
    if (sample.rr.length > 0) this.info.hasRR = true;
    sample.source = this.info.id;
    this.onSample(sample);
    // Lightweight device echo (battery/hasRR may have changed)
    this.emit();
  };

  private handleDisconnect = () => {
    if (this.manualDisconnect) {
      this.setStatus("disconnected");
      return;
    }
    this.setStatus("reconnecting");
    this.scheduleReconnect();
  };

  private scheduleReconnect(attempt = 0): void {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    const delay = Math.min(1000 * 2 ** attempt, 8000);
    this.reconnectTimer = window.setTimeout(async () => {
      if (this.manualDisconnect || !this.device) return;
      try {
        await this.openGatt();
      } catch {
        this.scheduleReconnect(Math.min(attempt + 1, 3));
      }
    }, delay);
  }

  disconnect(): void {
    this.manualDisconnect = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    try {
      this.char?.removeEventListener("characteristicvaluechanged", this.handleValue);
      this.batteryChar?.removeEventListener("characteristicvaluechanged", this.handleBattery);
      this.device?.removeEventListener("gattserverdisconnected", this.handleDisconnect);
      this.device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    this.setStatus("disconnected");
  }

  private setStatus(status: DeviceStatus): void {
    if (!this.info) return;
    this.info.status = status;
    this.emit();
  }

  private emit(): void {
    if (this.info) this.onDevice({ ...this.info });
  }
}

/** Parse a Heart Rate Measurement (0x2A37) DataView into an HRSample. */
export function parseHeartRate(dv: DataView, now = performance.timeOrigin + performance.now()): HRSample {
  // Smallest valid HR Measurement is flags(1) + uint8 HR(1) = 2 bytes.
  if (dv.byteLength < 2) return { t: now, hr: 0, rr: [], source: "ble" };

  const flags = dv.getUint8(0);
  let index = 1;

  const hr16 = (flags & 0x01) !== 0;
  let hr: number;
  if (hr16) {
    if (index + 2 > dv.byteLength) return { t: now, hr: 0, rr: [], source: "ble" };
    hr = dv.getUint16(index, true);
    index += 2;
  } else {
    hr = dv.getUint8(index);
    index += 1;
  }

  const energyPresent = (flags & 0x08) !== 0;
  if (energyPresent) index += 2; // skip energy expended (uint16)

  const rrPresent = (flags & 0x10) !== 0;
  const rr: number[] = [];
  if (rrPresent) {
    while (index + 1 < dv.byteLength) {
      const raw = dv.getUint16(index, true);
      index += 2;
      rr.push((raw / 1024) * 1000); // 1/1024 s units -> ms
    }
  }

  return { t: now, hr, rr, source: "ble" };
}
