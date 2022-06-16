import {Cell, ExternalMessage, InternalMessage, Slice} from "ton";
import {
    buildC7,
    C7Config,
    getSelectorForMethod,
    runTVM,
    TVMStack,
    TVMStackEntry,
    TVMStackEntryTuple
} from "../executor/executor";
import {compileFunc} from "ton-compiler";
import BN from "bn.js";
import {bocToCell, cellToBoc} from "../utils/cell";
import {TvmRunner, TvmRunnerAsynchronous} from "../executor/TvmRunner";
import {OutAction, parseActionsList, SetCodeAction} from "../utils/parseActionList";

type NormalizedStackEntry =
    | null
    | Cell
    | Slice
    | BN
    | NormalizedStackEntry[]

async function normalizeTvmStackEntry(entry: TVMStackEntry): Promise<NormalizedStackEntry> {
    if (entry.type === 'null') {
        return null
    }
    if (entry.type === 'cell') {
        return bocToCell(entry.value)
    }
    if (entry.type === 'int') {
        return new BN(entry.value, 10)
    }
    if (entry.type === 'cell_slice') {
        return Slice.fromCell(bocToCell(entry.value))
    }
    if (entry.type === 'tuple') {
        return await Promise.all(entry.value.map(v => normalizeTvmStackEntry(v)))
    }
    throw new Error('Unknown TVM stack entry' + JSON.stringify(entry))
}

async function normalizeTvmStack(stack: TVMStack) {
    return await Promise.all(stack.map(v => normalizeTvmStackEntry(v)))
}

type SmartContractConfig = {
    // Whether or not get methods should update smc data, false by default (useful for debug)
    getMethodsMutate: boolean
    // Return debug logs
    debug: boolean
    // Tvm runner for execution
    runner: TvmRunner
}

export type FailedExecutionResult = {
    type: 'failed'
    exit_code: number
    gas_consumed: number,
    result: NormalizedStackEntry[]
    actionList: OutAction[],
    action_list_cell?: Cell
    logs: string
}

export type SuccessfulExecutionResult = {
    type: 'success',
    exit_code: number,
    gas_consumed: number,
    result: NormalizedStackEntry[],
    actionList: OutAction[],
    action_list_cell?: Cell
    logs: string
}

export type ExecutionResult = FailedExecutionResult | SuccessfulExecutionResult

const decodeLogs = (logs: string) => Buffer.from(logs, 'base64').toString()

//
//  Mutable Smart Contract
//
//  Invoking mutating methods of contract mutates data cell
//
export class SmartContract {
    public codeCell: Cell
    public dataCell: Cell
    private codeCellBoc: string
    private dataCellBoc: string
    private config: SmartContractConfig
    private c7Config: C7Config = {}
    private c7: TVMStackEntryTuple | null = null

    private constructor(codeCell: Cell, dataCell: Cell, config?: Partial<SmartContractConfig>) {
        this.codeCell = codeCell
        this.dataCell = dataCell
        this.codeCellBoc = cellToBoc(codeCell)
        this.dataCellBoc = cellToBoc(dataCell)

        this.config = {
            getMethodsMutate: config?.getMethodsMutate ?? false,
            debug: config?.debug ?? false,
            runner: TvmRunnerAsynchronous.getShared()
        }
    }

    private async runContract(method: string, stack: TVMStack, opts: { mutateData: boolean, mutateCode: boolean }): Promise<ExecutionResult> {
        let executorConfig = {
            debug: this.config.debug,
            function_selector: getSelectorForMethod(method),
            init_stack: stack,
            code: this.codeCellBoc,
            data: this.dataCellBoc,
            c7_register: this.getC7()
        }
        let res = await this.config.runner.invoke(executorConfig)

        // In this case probably there wa something wrong with executor config
        if (!res.ok && res.error) {
            throw new Error(`Cant execute vm: ${res.error}}`)
        }

        // In this case TVM failed
        if (res.exit_code !== 0 || !res.ok) {
            let logs = res.logs ? decodeLogs(res.logs) : ''

            return {
                type: 'failed',
                exit_code: res.exit_code!,
                gas_consumed: 0,
                result: [] as NormalizedStackEntry[],
                action_list_cell: undefined,
                actionList: [],
                logs: logs,
            }
        }

        if (opts?.mutateData && res.data_cell) {
            this.setDataCell(bocToCell(res.data_cell))
        }

        let actionListCell = bocToCell(res.action_list_cell)
        let actionList = parseActionsList(actionListCell)

        let setCode = actionList.find(a => a.type === 'set_code')
        if (setCode && opts?.mutateCode) {
            this.setCodeCell((setCode as SetCodeAction).newCode)
        }

        return {
            type: 'success',
            exit_code: res.exit_code,
            gas_consumed: res.gas_consumed,
            result: await normalizeTvmStack(res.stack || []),
            action_list_cell: actionListCell,
            logs: decodeLogs(res.logs),
            actionList
        }
    }

    async invokeGetMethod(method: string, args: TVMStack): Promise<ExecutionResult> {
        return await this.runContract(method, args, {
            mutateData: this.config.getMethodsMutate,
            mutateCode: this.config.getMethodsMutate
        })
    }

    async sendInternalMessage(message: InternalMessage): Promise<ExecutionResult> {
        let msgCell = new Cell()
        message.writeTo(msgCell)

        if (!message.body.body) {
            throw new Error('No body was provided for message')
        }

        let bodyCell = new Cell()
        message.body.body.writeTo(bodyCell)


        let smcBalance = (this.c7Config.balance ?? new BN(0)).add(message.value)

        return await this.runContract('recv_internal', [
            {type: 'int', value: smcBalance.toString(10)},      // smc_balance
            {type: 'int', value: message.value.toString(10)},   // msg_value
            {type: 'cell', value: await cellToBoc(msgCell)},          // msg cell
            {type: 'cell_slice', value: await cellToBoc(bodyCell)},   // body slice
        ], {mutateCode: true, mutateData: true})
    }

    async sendExternalMessage(message: ExternalMessage): Promise<ExecutionResult> {
        let msgCell = new Cell()
        message.writeTo(msgCell)

        if (!message.body.body) {
            throw new Error('No body was provided for message')
        }

        let bodyCell = new Cell()
        message.body.body.writeTo(bodyCell)

        let smcBalance = (this.c7Config.balance ?? new BN(0))

        return await this.runContract('recv_external', [
            {type: 'int', value: smcBalance.toString(10)},    // smc_balance
            {type: 'int', value: '0'},                              // msg_value
            {type: 'cell', value: await cellToBoc(msgCell)},        // msg cell
            {type: 'cell_slice', value: await cellToBoc(bodyCell)}, // body slice
        ], {mutateCode: true, mutateData: true})
    }

    setUnixTime(time: number) {
        this.c7Config.unixtime = time
    }

    setBalance(value: BN) {
        this.c7Config.balance = value
    }

    setC7Config(conf: C7Config) {
        this.c7Config = conf
    }

    setC7(c7: TVMStackEntryTuple) {
        this.c7 = c7
    }

    getC7() {
        if (this.c7) {
            return this.c7
        } else {
            return buildC7(this.c7Config)
        }
    }

    setDataCell(dataCell: Cell) {
        this.dataCell = dataCell
        this.dataCellBoc = cellToBoc(dataCell)
    }

    setCodeCell(codeCell: Cell) {
        this.codeCell = codeCell
        this.codeCellBoc = cellToBoc(codeCell)
    }

    static async fromFuncSource(source: string, dataCell: Cell, config?: Partial<SmartContractConfig>) {
        let compiledSource = await compileFunc(source)
        return new SmartContract(Cell.fromBoc(compiledSource.cell)[0], dataCell, config)
    }

    static async fromCell(codeCell: Cell, dataCell: Cell, config?: Partial<SmartContractConfig>) {
        return new SmartContract(codeCell, dataCell, config)
    }
}