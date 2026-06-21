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
const RSC_SERVICE = "running_speed_and_cadence"; // 0x1814
const RSC_MEASUREMENT = "rsc_measurement"; // 0x2A53
const THERM_SERVICE = "health_thermometer"; // 0x1809
const TEMP_MEASUREMENT = "temperature_measurement"; // 0x2A1C

export function bluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/** iPhone/iPad — including iPadOS 13+ which reports a Mac UA but is touch. */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iDevice = /iPad|iPhone|iPod/.test(ua);
  const iPadOS = /Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document;
  return iDevice || iPadOS;
}

/**
 * Why pairing isn't available, tailored to the platform. On iOS NO browser
 * (Safari, Chrome, Edge — all WebKit) implements Web Bluetooth, so the honest
 * fix is to point the athlete at a Web-Bluetooth-capable browser (Bluefy) or
 * Demo mode rather than tell them to "use Chrome".
 */
export function bluetoothUnavailableMessage(): string {
  if (isIOS()) {
    return "iPhone & iPad browsers can't pair Bluetooth sensors — Apple doesn't support Web Bluetooth in Safari or iOS Chrome. To use your HRM on iOS, open RoxLive in the free “Bluefy” browser (App Store), or tap Demo to explore without a sensor.";
  }
  return "Web Bluetooth isn't available in this browser. Use Chrome or Edge on desktop or Android, then reload.";
}

type SampleCb = (s: HRSample) => void;
type DeviceCb = (d: DeviceInfo) => void;
type ErrCb = (msg: string) => void;
type CadenceCb = (t: number, spm: number) => void;
type TempCb = (t: number, c: number) => void;

export class HeartRateBLE {
  private device: BluetoothDevice | null = null;
  private char: BluetoothRemoteGATTCharacteristic | null = null;
  private batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  private rscChar: BluetoothRemoteGATTCharacteristic | null = null;
  private tempChar: BluetoothRemoteGATTCharacteristic | null = null;
  private info: DeviceInfo | null = null;
  private reconnectTimer: number | null = null;
  private manualDisconnect = false;

  constructor(
    private onSample: SampleCb,
    private onDevice: DeviceCb,
    private onError: ErrCb,
    private onCadence?: CadenceCb,
    private onTemp?: TempCb
  ) {}

  async connect(): Promise<void> {
    if (!bluetoothSupported()) {
      this.onError(bluetoothUnavailableMessage());
      return;
    }
    this.manualDisconnect = false;
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HR_SERVICE] }],
        optionalServices: [BATTERY_SERVICE, "device_information", RSC_SERVICE, THERM_SERVICE],
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

    // Battery + optional cadence / temperature (all best-effort)
    void this.readBattery(server);
    void this.subscribeOptional(server);

    this.setStatus("connected");
  }

  /** Subscribe to RSC cadence (0x1814) and thermometer (0x1809) if present. */
  private async subscribeOptional(server: BluetoothRemoteGATTServer): Promise<void> {
    if (this.onCadence) {
      try {
        const svc = await server.getPrimaryService(RSC_SERVICE);
        const ch = await svc.getCharacteristic(RSC_MEASUREMENT);
        // Only commit the ref + listener once notifications are actually live,
        // so a failed startNotifications() can't leave a dead characteristic.
        await ch.startNotifications();
        this.rscChar?.removeEventListener("characteristicvaluechanged", this.handleRsc);
        this.rscChar = ch;
        ch.addEventListener("characteristicvaluechanged", this.handleRsc);
        if (this.info) {
          this.info.hasCadence = true;
          this.emit();
        }
      } catch {
        /* no cadence sensor — fine */
      }
    }
    if (this.onTemp) {
      try {
        const svc = await server.getPrimaryService(THERM_SERVICE);
        const ch = await svc.getCharacteristic(TEMP_MEASUREMENT);
        await ch.startNotifications();
        this.tempChar?.removeEventListener("characteristicvaluechanged", this.handleTemp);
        this.tempChar = ch;
        ch.addEventListener("characteristicvaluechanged", this.handleTemp);
        if (this.info) {
          this.info.hasTemp = true;
          this.emit();
        }
      } catch {
        /* no thermometer — fine */
      }
    }
  }

  // RSC Measurement (0x2A53): flags(1), speed uint16, cadence uint8 @ offset 3.
  private handleRsc = (ev: Event) => {
    const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!dv || dv.byteLength < 4 || !this.onCadence) return;
    this.onCadence(performance.timeOrigin + performance.now(), dv.getUint8(3));
  };

  // Temperature Measurement (0x2A1C): flags(1), IEEE-11073 32-bit FLOAT.
  private handleTemp = (ev: Event) => {
    const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!dv || dv.byteLength < 5 || !this.onTemp) return;
    const flags = dv.getUint8(0);
    let c = parseMedicalFloat(dv, 1);
    if (flags & 0x01) c = ((c - 32) * 5) / 9; // value was Fahrenheit
    if (Number.isFinite(c)) this.onTemp(performance.timeOrigin + performance.now(), c);
  };

  private async readBattery(server: BluetoothRemoteGATTServer): Promise<void> {
    try {
      const svc = await server.getPrimaryService(BATTERY_SERVICE);
      const ch = await svc.getCharacteristic(BATTERY_LEVEL);
      const val = await ch.readValue();
      if (val.byteLength > 0 && this.info) {
        this.info.battery = val.getUint8(0);
        this.emit();
      }
      // Commit the ref + listener only after notifications are live, and clean
      // up any prior subscription (reconnect) once the new one succeeds.
      await ch.startNotifications();
      this.batteryChar?.removeEventListener("characteristicvaluechanged", this.handleBattery);
      this.batteryChar = ch;
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
      this.rscChar?.removeEventListener("characteristicvaluechanged", this.handleRsc);
      this.tempChar?.removeEventListener("characteristicvaluechanged", this.handleTemp);
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

/**
 * Parse an IEEE-11073 32-bit FLOAT (medical float) at `offset`, little-endian.
 * value = mantissa(24-bit signed) × 10^exponent(8-bit signed).
 */
export function parseMedicalFloat(dv: DataView, offset: number): number {
  const raw = dv.getUint32(offset, true);
  let mantissa = raw & 0x00ffffff;
  let exponent = (raw >> 24) & 0xff;
  if (exponent >= 0x80) exponent -= 0x100; // sign-extend 8-bit
  if (mantissa >= 0x800000) mantissa -= 0x1000000; // sign-extend 24-bit
  // IEEE-11073 reserved/NaN sentinels
  if (raw === 0x007fffff || raw === 0x00800000 || raw === 0x007ffffe) return NaN;
  return mantissa * Math.pow(10, exponent);
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
