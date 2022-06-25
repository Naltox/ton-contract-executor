import {TVMExecuteConfig} from "../executor/executor";

const VmExec: any = require('../vm-exec/vm-exec')

let instance: any = null
let isInitializing = false
let waiters: ((instance: any) => unknown)[] = []

async function getInstance() {
    if (instance) {
        return instance
    }

    if (isInitializing) {
        return new Promise<any>(resolve => waiters.push(resolve))
    }

    isInitializing = true
    instance = await VmExec()
    // Notify all waiters
    waiters.map(w => w(instance))
    waiters = []
    return instance
}

export async function vm_exec(config: TVMExecuteConfig) {
    let vmInstance = await getInstance()
    let bytes = vmInstance.intArrayFromString(JSON.stringify(config))
    let ref = vmInstance.allocate(bytes, VmExec.ALLOC_NORMAL)
    let res = vmInstance._vm_exec(bytes.length - 1, ref)
    let out = vmInstance.UTF8ToString(res)
    vmInstance._free(ref)
    vmInstance._free(res)
    return JSON.parse(out)
}