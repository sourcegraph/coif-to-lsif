import { writeLSIF } from './lsif'
import { Edge, Vertex } from 'lsif-protocol'
import _ from 'lodash'

async function indexExample(example: string): Promise<(Edge | Vertex)[]> {
    const output: (Edge | Vertex)[] = []

    await writeLSIF({
        inFileGlob: `examples/${example}/*.lsif.in`,
        root: `examples/${example}`,
        // inFileGlob: `/Users/chrismwendt/github.com/comby-tools/comby/**/*.lsif.in`,
        // root: `/Users/chrismwendt/github.com/comby-tools/comby`,
        emit: item =>
            new Promise(resolve => {
                output.push(item)
                resolve()
            }),
    })

    return output
}

test('does not emit items with duplicate IDs', async () => {
    const output = await indexExample('one')

    const setsOfDupes = _(output)
        .groupBy(item => item.id)
        .values()
        .map(group => ({ group, count: group.length }))
        .value()
        .filter(({ count }) => count > 1)
        .map(({ group }) => group)

    if (setsOfDupes.length > 0) {
        fail(
            new Error(
                `Sets of lines with duplicate IDs:\n` +
                    setsOfDupes
                        .map(dupes =>
                            dupes.map(item => JSON.stringify(item)).join('\n')
                        )
                        .join('\n\n')
            )
        )
    }
})

test.only('one', async () => {
    const output = (await indexExample('one')).map(v => JSON.stringify(v))
    expect(output.join('\n')).toMatchSnapshot()
})
