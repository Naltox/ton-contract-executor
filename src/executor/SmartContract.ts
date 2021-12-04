import {Cell, InternalMessage} from "ton";
import {runContractAssembly, TVMStack} from "./executor";
import {compileFunc} from "ton-compiler";

export const cellToBoc = async (cell: Cell) => {
    return (await cell.toBoc({idx: false})).toString('base64')
}

export const bocToCell = (boc: string) => {
    return Cell.fromBoc(Buffer.from(boc, 'base64'))[0]
}

class TVMExecutionException extends Error {
    public code: number

    constructor(code: number, message?: string) {
        super(message)

        this.code = code
    }
}

//
//  Mutable Smart Contract
//
//  Invoking mutating methods of contract mutates data cell
//

type SmartContractConfig = {
    // Whether or not get methods should update smc data, false by default (useful for debug)
    getMethodsMutate: boolean
}

export class SmartContract {
    private assemblyCode: string
    private dataCell: Cell
    private config: SmartContractConfig

    private constructor(assemblyCode: string, dataCell: Cell, config?: SmartContractConfig) {
        this.assemblyCode = assemblyCode
        this.dataCell = dataCell
        this.config = config || { getMethodsMutate: false }
    }

    async invokeGetMethod(method: string, args: TVMStack) {
        let res = await runContractAssembly(
            this.assemblyCode,
            this.dataCell,
            args,
            method
        )
        if (res.exit_code !== 0) {
            throw new TVMExecutionException(res.exit_code)
        }
        if (this.config.getMethodsMutate && res.data_cell) {
            this.dataCell = bocToCell(res.data_cell)
        }

        return res
    }

    async sendInternalMessage(message: InternalMessage) {
        let msgCell = new Cell()
        message.writeTo(msgCell)

        let bodyCell = new Cell()
        message.body.writeTo(bodyCell)

        let res = await runContractAssembly(
            this.assemblyCode,
            this.dataCell,
            [
                {type: 'int', value: message.value},
                {type: 'cell', value: await cellToBoc(msgCell) },
                {type: 'cell_slice', value: await cellToBoc(bodyCell) },
            ],
            'recv_internal'
        )
        if (res.exit_code !== 0) {
            throw new TVMExecutionException(res.exit_code)
        }

        if (res.data_cell) {
            this.dataCell = bocToCell(res.data_cell)
        }

        // TODO: handle code update

        return res
    }

    static async fromFuncSource(source: string, dataCell: Cell, config?: SmartContractConfig) {
        let compiledSource = await compileFunc(source)
        return new SmartContract(compiledSource.fift, dataCell, config)
    }

    static async fromAssembly(source: string, dataCell: Cell, config?: SmartContractConfig) {
        return new SmartContract(source, dataCell, config)
    }
}