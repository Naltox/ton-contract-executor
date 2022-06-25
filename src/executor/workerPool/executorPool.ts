import {Worker} from "worker_threads";
import {TVMExecuteConfig, TVMExecutionResult} from "../executor";

type WorkerResponseMessage = {
    id: number
    result: TVMExecutionResult
}

const getWorker = () => {
    if (__filename.endsWith('.ts')) {
        return new Worker(__dirname + '/worker.js', {
            workerData: {
                path: './executorWorker.ts'
            }
        })
    } else {
        return new Worker(__dirname + '/executorWorker.js')
    }
}

export class ExecutorPool {
    private reqNo = 0
    private workers: Worker[] = []
    private tasks = new Map<number, (result: any) => void>()
    private maxSize: number
    private processingRequestsCount = 0

    constructor(maxSize: number) {
        this.maxSize = maxSize
    }

    private createWorker() {
        let worker = getWorker()
        worker.on('message', msg => {
          this.processingRequestsCount--
          this.onWorkerMessage(msg)
        })
        this.workers.push(worker)
    }

    private onWorkerMessage(message: WorkerResponseMessage) {
        let cb = this.tasks.get(message.id)
        if (!cb) {
            throw new Error('No callback was found for response: ' + JSON.stringify(message))
        }
        cb(message.result)
        this.tasks.delete(message.id)
    }

    execute(config: TVMExecuteConfig): Promise<TVMExecutionResult> {
        if (!this.workers.length || (this.workers.length < this.maxSize && this.processingRequestsCount > 0)) {
          this.createWorker()
        }
        let requestId = this.reqNo++
        let worker = this.workers[requestId % this.workers.length]

        this.processingRequestsCount++
        worker.postMessage({
            id: requestId,
            config
        })

        return new Promise(resolve => {
            this.tasks.set(requestId, resolve)
        })
    }

    public canCleanup() {
      return this.processingRequestsCount <= 0;
    }

    public async cleanup() {
      if (!this.canCleanup()) {
        throw new Error('cant cleanup now')
      }
      const workers = this.workers;
      this.workers = [];
      for(const worker of workers) {
        await worker.terminate()
      }
    }
}