import { SyncLog } from "./syncLog";
import { CrosspointAbstraction } from "./crosspointAbstraction";
import type { CrosspointState, CrosspointDevice, CrosspointFlow } from "./crosspointAbstraction";

const fs = require("fs");
const path = require("path");

export interface PresetConnection {
    srcId: string;
    dstId: string;
}

export interface Preset {
    id: string;
    name: string;
    type: "relative" | "absolute";
    connections: PresetConnection[];
    createdAt: string;
    updatedAt: string;
}

export interface PresetStore {
    presets: Preset[];
}

export class PresetManager {
    private storePath: string;
    private store: PresetStore = { presets: [] };

    constructor(configDir: string = "./config") {
        this.storePath = path.join(configDir, "presets.json");
        this.load();
    }

    private load() {
        try {
            if (fs.existsSync(this.storePath)) {
                let raw = fs.readFileSync(this.storePath, "utf-8");
                this.store = JSON.parse(raw);
            }
        } catch (e: any) {
            SyncLog.log("error", "presets", "Error loading presets: " + e.message);
            this.store = { presets: [] };
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
        } catch (e: any) {
            SyncLog.log("error", "presets", "Error saving presets: " + e.message);
        }
    }

    getPresets(): Preset[] {
        return this.store.presets;
    }

    getPreset(id: string): Preset | null {
        return this.store.presets.find(p => p.id === id) || null;
    }

    /**
     * Save a preset. 
     * - "relative" presets store only the connections that differ from disconnected state (changes only)
     * - "absolute" presets store ALL current receiver connections (full state snapshot)
     */
    savePreset(name: string, type: "relative" | "absolute", crosspointState: CrosspointState, selectedConnections?: PresetConnection[]): Preset {
        let connections: PresetConnection[] = [];

        if (type === "relative" && selectedConnections) {
            // Relative preset: only store the provided connections (changes)
            connections = selectedConnections;
        } else {
            // Absolute preset: store all current connections
            for (let dev of crosspointState.devices) {
                for (let rType of Object.keys(dev.receivers)) {
                    for (let flow of dev.receivers[rType]) {
                        if (flow.connectedFlowId && flow.connectedFlowId !== "") {
                            connections.push({
                                srcId: flow.connectedFlowId,
                                dstId: flow.id
                            });
                        } else {
                            // For absolute presets, store disconnected state too
                            if (type === "absolute") {
                                connections.push({
                                    srcId: "",
                                    dstId: flow.id
                                });
                            }
                        }
                    }
                }
            }
        }

        let id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        let now = new Date().toISOString();
        let preset: Preset = {
            id,
            name,
            type,
            connections,
            createdAt: now,
            updatedAt: now
        };

        this.store.presets.push(preset);
        this.save();
        SyncLog.log("info", "presets", `Saved ${type} preset: "${name}" with ${connections.length} connections`);
        return preset;
    }

    updatePreset(id: string, crosspointState: CrosspointState, selectedConnections?: PresetConnection[]): Preset | null {
        let preset = this.store.presets.find(p => p.id === id);
        if (!preset) return null;

        let connections: PresetConnection[] = [];

        if (preset.type === "relative" && selectedConnections) {
            connections = selectedConnections;
        } else {
            for (let dev of crosspointState.devices) {
                for (let rType of Object.keys(dev.receivers)) {
                    for (let flow of dev.receivers[rType]) {
                        if (flow.connectedFlowId && flow.connectedFlowId !== "") {
                            connections.push({
                                srcId: flow.connectedFlowId,
                                dstId: flow.id
                            });
                        } else if (preset.type === "absolute") {
                            connections.push({
                                srcId: "",
                                dstId: flow.id
                            });
                        }
                    }
                }
            }
        }

        preset.connections = connections;
        preset.updatedAt = new Date().toISOString();
        this.save();
        SyncLog.log("info", "presets", `Updated ${preset.type} preset: "${preset.name}" with ${connections.length} connections`);
        return preset;
    }

    deletePreset(id: string): boolean {
        let len = this.store.presets.length;
        this.store.presets = this.store.presets.filter(p => p.id !== id);
        if (this.store.presets.length < len) {
            this.save();
            SyncLog.log("info", "presets", `Deleted preset: ${id}`);
            return true;
        }
        return false;
    }

    renamePreset(id: string, name: string): Preset | null {
        let preset = this.store.presets.find(p => p.id === id);
        if (!preset) return null;
        preset.name = name;
        preset.updatedAt = new Date().toISOString();
        this.save();
        return preset;
    }

    /**
     * Recall a preset — returns the list of connections to execute.
     * For "relative" presets: only the stored connections are returned.
     * For "absolute" presets: all connections are returned (including disconnects for receivers not in the preset).
     */
    recallPreset(id: string, crosspointState: CrosspointState): { source: string, destination: string }[] | null {
        let preset = this.store.presets.find(p => p.id === id);
        if (!preset) return null;

        let connectionList: { source: string, destination: string }[] = [];

        if (preset.type === "relative") {
            // Only apply the stored connections
            for (let conn of preset.connections) {
                let srcString = this.flowIdToConnectionString(conn.srcId, crosspointState, "sender");
                let dstString = this.flowIdToConnectionString(conn.dstId, crosspointState, "receiver");
                if (dstString) {
                    connectionList.push({
                        source: srcString || "__disconnect",
                        destination: dstString
                    });
                }
            }
        } else {
            // Absolute: apply all connections including disconnects
            for (let conn of preset.connections) {
                let dstString = this.flowIdToConnectionString(conn.dstId, crosspointState, "receiver");
                if (dstString) {
                    if (conn.srcId && conn.srcId !== "") {
                        let srcString = this.flowIdToConnectionString(conn.srcId, crosspointState, "sender");
                        if (srcString) {
                            connectionList.push({
                                source: srcString,
                                destination: dstString
                            });
                        }
                    } else {
                        connectionList.push({
                            source: "__disconnect",
                            destination: dstString
                        });
                    }
                }
            }
        }

        return connectionList;
    }

    private flowIdToConnectionString(flowId: string, state: CrosspointState, role: "sender" | "receiver"): string | null {
        if (!flowId || flowId === "") return null;

        for (let dev of state.devices) {
            let flows = role === "sender" ? dev.senders : dev.receivers;
            for (let type of Object.keys(flows)) {
                for (let flow of flows[type]) {
                    if (flow.id === flowId) {
                        let typeChar = "u";
                        switch (flow.type) {
                            case "video": typeChar = "v"; break;
                            case "audio": typeChar = "a"; break;
                            case "data": typeChar = "d"; break;
                        }
                        return dev.num + "." + typeChar + flow.num;
                    }
                }
            }
        }
        return null;
    }
}
