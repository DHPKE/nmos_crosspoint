/*
    NMOS Crosspoint
    Preset / Snapshot management

    Design notes:
    - Presets are stored keyed by each flow's *id* (e.g. "nmos_<uuid>"), never by the
      device/flow "num" used in crosspoint addressing ("3.v2"-style). The `num` values are
      session/order-based and can be reassigned when a device drops out and rejoins or when
      the operator reorders the panel, whereas `id` is the stable NMOS (or local device)
      identity. Presets are resolved to a `num`-based address only at recall time.
    - ABSOLUTE preset: captures the connection state of every known receiver at save time,
      including receivers that were disconnected (stored with sourceId:""). Recalling an
      absolute preset re-asserts the entire routing state, including disconnecting things
      that were disconnected when it was captured.
    - RELATIVE preset: captures only the receivers explicitly passed in via `receiverIds`
      (a "scene" that changes just those destinations and leaves everything else alone).
    - Recall never throws or silently drops an endpoint that no longer exists: it returns
      the connections it *can* make plus a list of human-readable warnings for the ones it
      can't, so the caller can surface that to the operator instead of the request quietly
      doing less than expected.
*/

import { SyncObject } from "./SyncServer/syncObject";
import { SyncLog } from "./syncLog";
import { CrosspointState } from "./crosspointAbstraction";

const fs = require("fs");

export interface PresetConnection {
    destinationId: string;
    destinationLabel: string;
    sourceId: string;       // "" means "disconnected" at capture time
    sourceLabel: string;
}

export interface Preset {
    id: string;
    name: string;
    type: "absolute" | "relative";
    connections: PresetConnection[];
    createdAt: number;
    updatedAt: number;
}

interface PresetFileState {
    presets: { [id: string]: Preset };
}

interface ResolvedConnection {
    source: string;
    destination: string;
}

interface FlowIndexEntry {
    address: string;
    label: string;
}

const TYPE_CHAR: { [key: string]: string } = {
    video: "v",
    audio: "a",
    data: "d",
    audiochannel: "c",
    websocket: "w",
    mqtt: "m",
    unknown: "u",
};

export class PresetManager {
    public static instance: PresetManager | null = null;

    public syncPresets: SyncObject;

    private state: PresetFileState = { presets: {} };

    constructor() {
        if (PresetManager.instance == null) {
            PresetManager.instance = this;
        }
        this.load();
        this.syncPresets = new SyncObject("presets", this.list());
    }

    private load() {
        try {
            let raw = fs.readFileSync("./state/presets.json");
            this.state = JSON.parse(raw);
            if (!this.state || typeof this.state.presets !== "object") {
                throw new Error("malformed presets.json");
            }
        } catch (e) {
            SyncLog.log(
                "warning",
                "Presets",
                "No usable ./state/presets.json found, starting with an empty preset list.",
                null
            );
            this.state = { presets: {} };
        }
    }

    private persist() {
        try {
            if (!fs.existsSync("./state")) {
                fs.mkdirSync("./state");
            }
            fs.writeFileSync("./state/presets.json", JSON.stringify(this.state, null, 2));
        } catch (e) {
            // This one we do NOT swallow silently: a preset the operator thinks is saved
            // but isn't is exactly the kind of failure that erodes trust in the tool.
            SyncLog.log("error", "Presets", "Failed to write ./state/presets.json - preset NOT durably saved.", e);
            throw e;
        }
    }

    private pushSync() {
        this.syncPresets.setState(this.list());
    }

    list(): Preset[] {
        return Object.values(this.state.presets).sort((a, b) => a.name.localeCompare(b.name));
    }

    get(id: string): Preset | null {
        return this.state.presets[id] || null;
    }

    private buildFlowIndex(crosspointState: CrosspointState) {
        let senderIndex: { [id: string]: FlowIndexEntry } = {};
        let receiverIndex: { [id: string]: FlowIndexEntry & { connectedFlow: string } } = {};

        for (let dev of crosspointState.devices) {
            for (let type of Object.keys(dev.senders)) {
                for (let flow of (dev.senders as any)[type]) {
                    senderIndex[flow.id] = {
                        address: `${dev.num}.${TYPE_CHAR[type] || "u"}${flow.num}`,
                        label: `${dev.alias || dev.name} / ${flow.alias || flow.name}`,
                    };
                }
            }
            for (let type of Object.keys(dev.receivers)) {
                for (let flow of (dev.receivers as any)[type]) {
                    receiverIndex[flow.id] = {
                        address: `${dev.num}.${TYPE_CHAR[type] || "u"}${flow.num}`,
                        label: `${dev.alias || dev.name} / ${flow.alias || flow.name}`,
                        connectedFlow: flow.connectedFlow,
                    };
                }
            }
        }
        return { senderIndex, receiverIndex };
    }

    save(
        name: string,
        type: "absolute" | "relative",
        crosspointState: CrosspointState,
        receiverIds?: string[],
        existingId?: string
    ): Preset {
        if (!name || !name.trim()) {
            throw new Error("Preset name must not be empty.");
        }
        const { receiverIndex } = this.buildFlowIndex(crosspointState);

        let targetIds: string[];
        if (type === "absolute") {
            targetIds = Object.keys(receiverIndex);
        } else {
            targetIds = (receiverIds || []).filter((id) => receiverIndex.hasOwnProperty(id));
            if (targetIds.length === 0) {
                throw new Error("Relative preset needs at least one selected receiver.");
            }
        }

        let connections: PresetConnection[] = targetIds.map((id) => {
            let r = receiverIndex[id];
            return {
                destinationId: id,
                destinationLabel: r.label,
                sourceId: r.connectedFlow || "",
                sourceLabel: r.connectedFlow || "(disconnected)",
            };
        });

        let id = existingId && this.state.presets[existingId] ? existingId : this.generateId();
        let now = Date.now();
        let preset: Preset = {
            id,
            name: name.trim(),
            type,
            connections,
            createdAt: this.state.presets[id] ? this.state.presets[id].createdAt : now,
            updatedAt: now,
        };

        this.state.presets[id] = preset;
        this.persist();
        this.pushSync();
        SyncLog.log(
            "info",
            "Presets",
            `Saved ${type} preset "${preset.name}" (${connections.length} connection${connections.length === 1 ? "" : "s"}).`,
            null
        );
        return preset;
    }

    delete(id: string) {
        if (this.state.presets[id]) {
            let name = this.state.presets[id].name;
            delete this.state.presets[id];
            this.persist();
            this.pushSync();
            SyncLog.log("info", "Presets", `Deleted preset "${name}".`, null);
        }
    }

    rename(id: string, name: string) {
        if (this.state.presets[id] && name && name.trim()) {
            this.state.presets[id].name = name.trim();
            this.state.presets[id].updatedAt = Date.now();
            this.persist();
            this.pushSync();
        }
    }

    /**
     * Resolve a stored preset against the *current* crosspoint state.
     * Never throws for missing endpoints - returns what it can apply plus warnings
     * for anything it can't, so callers can decide how to surface partial application.
     */
    resolve(
        id: string,
        crosspointState: CrosspointState
    ): { multiple: ResolvedConnection[]; warnings: string[]; presetName: string | null } {
        let preset = this.get(id);
        if (!preset) {
            return { multiple: [], warnings: [`Preset with id "${id}" does not exist.`], presetName: null };
        }

        const { senderIndex, receiverIndex } = this.buildFlowIndex(crosspointState);
        let multiple: ResolvedConnection[] = [];
        let warnings: string[] = [];

        for (let c of preset.connections) {
            let dst = receiverIndex[c.destinationId];
            if (!dst) {
                warnings.push(`Destination "${c.destinationLabel}" is no longer present, skipped.`);
                continue;
            }
            if (!c.sourceId) {
                multiple.push({ source: "__disconnect", destination: dst.address });
                continue;
            }
            let src = senderIndex[c.sourceId];
            if (!src) {
                warnings.push(
                    `Source "${c.sourceLabel}" for destination "${c.destinationLabel}" is no longer present, skipped.`
                );
                continue;
            }
            multiple.push({ source: src.address, destination: dst.address });
        }

        return { multiple, warnings, presetName: preset.name };
    }

    private generateId(): string {
        return "preset_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    }
}
