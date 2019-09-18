import yargs from 'yargs'
import * as fs from 'fs'
import * as sourceMapSupport from 'source-map-support'
import { writeLSIF } from './lsif'
sourceMapSupport.install()

// Causes node to print all stacks from nested VErrors.
process.on('uncaughtException', error => {
    console.log(error)
    process.exit(1)
})

// tslint:disable:no-floating-promises
main()

async function main() {
    const { inFileGlob, root, out } = yargs
        .demandOption('inFileGlob')
        .demandOption('out')
        .demandOption('root').argv as {
        inFileGlob: string
        root: string
        out: string
    }

    try {
        fs.unlinkSync(out)
    } catch (e) {
        // yolo
    }

    try {
        await writeLSIF({
            inFileGlob,
            root,
            emit: item =>
                new Promise(resolve => {
                    fs.appendFileSync(out, JSON.stringify(item) + '\n')
                    resolve()
                }),
        })
    } catch (e) {
        console.error(e)
        process.exit(1)
    }
}
