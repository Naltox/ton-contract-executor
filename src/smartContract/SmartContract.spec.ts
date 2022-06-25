import {SmartContract} from "./SmartContract";
import {Address, Cell, CellMessage, CommonMessageInfo, ExternalMessage, InternalMessage, Slice, toNano} from "ton";
import {
    TVMStackEntryTuple
} from "../executor/executor";
import BN from "bn.js";
import {cellToBoc} from "../utils/cell";
import {SendMsgAction} from "../utils/parseActionList";
import { TvmRunnerAsynchronous } from "../executor/TvmRunner";

describe('SmartContract', () => {
    it('should run basic contract', async () => {
        const source = `
            () main() {
                ;; noop
            }

            int test() method_id {
                return 777;
            }
        `
        let contract = await SmartContract.fromFuncSource(source, new Cell())
        let res = await contract.invokeGetMethod('test', [])

        expect(res.result[0]).toBeInstanceOf(BN)
        expect(res.result[0]).toEqual(new BN(777))
    })

    it('handle cells', async () => {
        const source = `
            () main() {
                ;; noop
            }

            cell test(cell in_cell) method_id {
                return in_cell;
            }
        `
        let contract = await SmartContract.fromFuncSource(source, new Cell())
        let cell = new Cell()
        cell.bits.writeUint(0xFFFFFFFF, 32)

        let res = await contract.invokeGetMethod('test', [{type: 'cell', value: cellToBoc(cell) }])

        expect(res.result[0]).toBeInstanceOf(Cell)
        expect((res.result[0] as Cell).toString()).toEqual(cell.toString())
    })

    it('handle integers', async () => {
        const source = `
            () main() {
                ;; noop
            }

            int test(int in_int) method_id {
                return in_int;
            }
        `
        let contract = await SmartContract.fromFuncSource(source, new Cell())

        let res = await contract.invokeGetMethod('test', [{type: 'int', value: '123'}])

        expect(res.result[0]).toBeInstanceOf(BN)
        expect(res.result[0]).toEqual(new BN(123))
    })

    it('handle tuples', async () => {
        const source = `
            () main() {
                ;; noop
            }

            [int, int] test([int, int] in_tuple) method_id {
                return in_tuple;
            }
        `
        let contract = await SmartContract.fromFuncSource(source, new Cell())

        let tuple: TVMStackEntryTuple = {
            type: 'tuple',
            value: [
                {type: 'int', value: '1'},
                {type: 'int', value: '2'},
            ]
        }

        let res = await contract.invokeGetMethod('test', [tuple])
        expect(res.result[0]).toEqual([
            new BN(1),
            new BN(2)
        ])
    })

    it('should update contract state between calls', async () => {
        const source = `
            () main() {
                ;; noop
            }

            int test() method_id {
                ;; Load seq from data
                slice ds = get_data().begin_parse();
                var seq = ds~load_uint(32);
                ds.end_parse();

                ;; Store new seq
                set_data(begin_cell().store_uint(seq + 1, 32).end_cell());

                return seq;
            }
        `
        let dataCell = new Cell()
        dataCell.bits.writeUint(0, 32)

        let contract = await SmartContract.fromFuncSource(source, dataCell, {getMethodsMutate: true})

        let res = await contract.invokeGetMethod('test', [])
        expect(res.result[0]).toEqual(new BN(0))

        let res2 = await contract.invokeGetMethod('test', [])
        expect(res2.result[0]).toEqual(new BN(1))

        let res3 = await contract.invokeGetMethod('test', [])
        expect(res3.result[0]).toEqual(new BN(2))
    })

    it('should handle custom time', async () => {
        const source = `
            () main() {
                ;; noop
            }

            int get_time() method_id {
                return now();
            }
        `
        let now = Math.floor(Date.now() / 1000)
        let contract = await SmartContract.fromFuncSource(source, new Cell())
        contract.setUnixTime(now)
        let res = await contract.invokeGetMethod('get_time', [])

        expect(res.result[0]).toBeInstanceOf(BN)
        expect(res.result[0]).toEqual(new BN(now))
    })

    it('should handle custom balance', async () => {
        const source = `
            () main() {
                ;; noop
            }

            int my_balance() method_id {
                [int res, cell a] = get_balance();
                return res;
            }
        `
        let contract = await SmartContract.fromFuncSource(source, new Cell())
        contract.setBalance(new BN(777))
        let res = await contract.invokeGetMethod('my_balance', [])

        expect(res.result[0]).toBeInstanceOf(BN)
        expect(res.result[0]).toEqual(new BN(777))
    })

    it('should handle internal messages', async () => {
        const source = `
            (cell, slice) recv_internal(int smc_balance, int msg_value, cell msg, slice msg_body) {
                throw_if(403, smc_balance != 1000000500);
                return (msg, msg_body);
            }
        `

        let contract = await SmartContract.fromFuncSource(source, new Cell())
        contract.setBalance(new BN(500));
        let bodyCell = new Cell()
        bodyCell.bits.writeUint(777, 256)

        let msg = new InternalMessage({
            to: Address.parse('EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t'),
            value: toNano(1),
            bounce: false,
            body: new CommonMessageInfo({
                body: new CellMessage(bodyCell)
            })
        })

        let msgCell = new Cell()
        msg.writeTo(msgCell)

        let res = await contract.sendInternalMessage(msg)
        expect(res.exit_code).toEqual(0)
        let [resCell, resBody] = res.result as [Cell, Slice]
        expect(resCell.toString()).toEqual(msgCell.toString())
        expect(resBody.toCell().toString()).toEqual(bodyCell.toString())
    })

    it('should handle external messages', async () => {
        const source = `
            (cell, slice) recv_internal(int smc_balance, int msg_value, cell msg, slice msg_body) {
                return (msg, msg_body);
            }

             (cell, slice) recv_external(int smc_balance, int msg_value, cell msg, slice msg_body) {
                return (msg, msg_body);
            }
        `

        let contract = await SmartContract.fromFuncSource(source, new Cell())
        let bodyCell = new Cell()
        bodyCell.bits.writeUint(777, 256)

        let msg = new ExternalMessage({
            to: Address.parse('EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t'),
            body: new CommonMessageInfo({
                body: new CellMessage(bodyCell)
            })
        })

        let msgCell = new Cell()
        msg.writeTo(msgCell)

        let res = await contract.sendExternalMessage(msg)
        let [resCell, resBody] = res.result as [Cell, Slice]
        expect(resCell.toString()).toEqual(msgCell.toString())
        expect(resBody.toCell().toString()).toEqual(bodyCell.toString())
    })

    it('should return actions', async () => {
        const source = `
            () send_money(slice address, int amount) impure inline {
                var msg = begin_cell()
                    .store_uint(0x10, 6) ;; nobounce
                    .store_slice(address)
                    .store_grams(amount)
                    .store_uint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
                    .end_cell();
            
                send_raw_message(msg, 64);
            }    
                     
            () recv_internal(int my_balance, int msg_value, cell in_msg_full, slice in_msg_body) {
                slice cs = in_msg_full.begin_parse();
                int flags = cs~load_uint(4);
                slice sender_address = cs~load_msg_addr();    
                send_money(sender_address, 1);
                return ();
            }
        `

        let contract = await SmartContract.fromFuncSource(source, new Cell())

        let res = await contract.sendInternalMessage(new InternalMessage({
            to: Address.parse('EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t'),
            value: toNano(1),
            bounce: false,
            body: new CommonMessageInfo({
                body: new CellMessage(new Cell())
            })
        }))
        expect(res.actionList).toHaveLength(1)
        let msgAction = res.actionList[0] as SendMsgAction
        expect(msgAction.type).toEqual('send_msg')
        expect(msgAction.mode).toEqual(64)
    })

    it('should handle code change', async () => {
        const source = `      
            () recv_internal(int my_balance, int msg_value, cell in_msg_full, slice in_msg_body) {
                set_code(begin_cell().end_cell());
                return ();
            }
        `
        let contract = await SmartContract.fromFuncSource(source, new Cell())
        let res = await contract.sendInternalMessage(new InternalMessage({
            to: Address.parse('EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t'),
            value: toNano(1),
            bounce: false,
            body: new CommonMessageInfo({
                body: new CellMessage(new Cell())
            })
        }))

        expect(contract.codeCell.equals(new Cell())).toBe(true)
    })

    it('should handle exceptions', async () => {
        const source = `
            () main() {
                ;; noop
            }

            int test() method_id {
                throw(777);
                return 777;
            }
        `
        let contract = await SmartContract.fromFuncSource(source, new Cell())
        let res = await contract.invokeGetMethod('test', [])
        expect(res.exit_code).toEqual(777)
    })

    afterAll(async () => {
      // close all opened threads
      await TvmRunnerAsynchronous.getShared().cleanup()
    })
})