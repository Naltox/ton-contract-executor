import {ExecutorPool} from "./executorPool";

let config = {
    "function_selector": 105222,
    "init_stack": [{"type": "int", "value": "123"}],
    "code": "te6cckEBBAEAGgABFP8A9KQT9LzyyAsBAgFiAwIABaE2DQAC0M55Hpc=",
    "data": "te6cckEBAQEAAgAAAEysuc0=",
    "c7_register": {
        "type": "tuple",
        "value": [{
            "type": "tuple",
            "value": [{"type": "int", "value": "124711402"}, {"type": "int", "value": "0"}, {
                "type": "int",
                "value": "0"
            }, {"type": "int", "value": "1649373789"}, {"type": "int", "value": "1649373789"}, {
                "type": "int",
                "value": "1649373789"
            }, {
                "type": "int",
                "value": "19769373100962714100569008761681790735898494820591766541367229706950749369754"
            }, {"type": "tuple", "value": [{"type": "int", "value": "1000"}, {"type": "null"}]}, {
                "type": "cell_slice",
                "value": "te6cckEBAQEAJAAAQ4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBK7IKd"
            }, {"type": "cell", "value": "te6cckEBAQEAAgAAAEysuc0="}]
        }]
    }
}

describe('ExecutorPool', () => {
    it('should execute', async () => {
        let pool = new ExecutorPool(2)

        let pr: Promise<any>[] = []

        for (let i = 0; i < 1000; i++) {
            pr.push(pool.execute(config as any))
        }
        await Promise.all(pr)
        await pool.cleanup()
    })
})