import * as path from 'path'
import * as util from 'util'
import * as fs from 'fs'
import {
    fromPairs,
    chunk,
    Dictionary,
    isEqual,
    difference,
    groupBy,
    map as mapObject,
    map,
    forEach,
    toPairs,
} from 'lodash'
import {
    Document,
    Edge,
    ElementTypes,
    HoverResult,
    // Range,
    MetaData,
    Vertex,
    VertexLabels,
    Moniker,
    PackageInformation,
    Id,
    EdgeLabels,
    ItemEdge,
    V,
    Project,
    EventKind,
    EventScope,
    ProjectEvent,
    DocumentEvent,
    Range,
    ResultSet,
    DefinitionResult,
    ReferenceResult,
    contains,
    next,
    textDocument_definition,
    item,
    textDocument_references,
    ItemEdgeProperties,
    MonikerKind,
    moniker,
    packageInformation,
    textDocument_hover,
} from 'lsif-protocol'
import * as lsp from 'vscode-languageserver-protocol'
import * as P from 'parsimmon'
import glob from 'glob'
import Database from 'better-sqlite3'

// What are all of the kinds? According to DXR source code:
//
// rg "^\s*beginRecord" dxr/plugins/clang/dxr-index.cpp | gsed "s/^ *beginRecord..\(\w\+\).*/\1/" | sort
//
// call call decldef func_override function impl include macro namespace namespace_alias ref ref type typedef typedef variable warning
//
// TODO exhaustiveness check: make sure all kinds and fields are used (or at least acknowledged) by this converter.

type Emit = <T extends Edge | Vertex>(item: T) => Promise<void>

// {
//   "start": {
//     "line": 99,
//     "col": 62
//   },
//   "end": {
//     "line": 99,
//     "col": 68
//   },
//   "definition": {
//     "file": "*buffer*",
//     "pos": {
//       "line": 57,
//       "col": 4
//     }
//   },
//   "type": "[< `Path of string | `String of string ]"
// }
//
// file,start,end,deffile,defstart,type?
// docs = SELECT DISTINCT file
// rangesByDoc = SELECT start,end GROUP BY file

type Doc_ = string
type Range_ = string
type Ref_ = Range_
type Def_ = Range_

export async function writeLSIF({
    inFileGlob,
    root,
    emit,
}: {
    inFileGlob: string
    root: string
    emit: Emit
}): Promise<void> {
    const docs = new Set<Doc_>()
    const rangesByDoc = new Map<Doc_, Set<Range_>>()
    const hoverByDef = new Map<Def_, string>()
    const refsByDef = new Map<Def_, Set<Ref_>>()
    const locByRange = new Map<Range_, lsp.Location>()
    const importMonikerByRange = new Map<
        Range_,
        { moniker: string; packageInformation: string }
    >()
    const exportMonikerByRange = new Map<
        Range_,
        { moniker: string; packageInformation: string }
    >()

    const inFiles = glob.sync(inFileGlob)
    if (inFiles.length === 0) {
        throw new Error(`glob ${inFileGlob} did not match any files`)
    }

    try {
        fs.unlinkSync('data.sqlite')
    } catch (e) {
        // yolo
    }
    const db = new Database('data.sqlite')
    db.exec(`DROP TABLE IF EXISTS lines`)
    db.exec(`CREATE TABLE lines (
            file TEXT NOT NULL,
            start TEXT NOT NULL,
            end TEXT NOT NULL,
            deffile TEXT NOT NULL,
            defstart TEXT NOT NULL,
            type TEXT NOT NULL,
            UNIQUE (file, start, end)
        )`)

    for (const inFile of inFiles) {
        const insert = db.prepare(
            'INSERT OR REPLACE INTO lines (file, start, end, deffile, defstart, type) VALUES (@file, @start, @end, @deffile, @defstart, @type)'
        )

        const insertMany = db.transaction(lines => {
            for (const line of lines) insert.run(line)
        })

        const sourceFile = inFile
            .slice(root.length + 1 /* for the slash */)
            .replace(/.lsif.in$/, '')

        insertMany(
            fs
                .readFileSync(inFile)
                .toString()
                .trimRight()
                .split('\n')
                .map(line => JSON.parse(line))
                .filter(line => 'start' in line)
                .map(line => {
                    try {
                        line.start.line = line.start.line - 1
                        line.end.line = line.end.line - 1
                        line.definition.pos.line = line.definition.pos.line - 1
                        line.definition.file =
                            line.definition.file === '*buffer*'
                                ? sourceFile
                                : line.definition.file
                        return line
                    } catch (e) {
                        console.log('Error on line', line)
                        throw e
                    }
                })
                .filter(line => !line.definition.file.startsWith('/'))
                .map(line => ({
                    file: sourceFile,
                    start: stringifyPosition(line.start),
                    end: stringifyPosition(line.end),
                    deffile: line.definition.file,
                    defstart: stringifyPosition(line.definition.pos),
                    type: (line.type || '<unknown>').slice(0, 200),
                }))
        )
    }

    // db.exec(`DROP TABLE IF EXISTS lines`)

    // db.exec(`CREATE TABLE symbols (
    //     deffile TEXT NOT NULL,
    //     defstart TEXT NOT NULL,
    //     type TEXT NOT NULL
    // )`)
    // db.exec(
    //     'INSERT INTO symbols (deffile, defstart, type) SELECT deffile, defstart, type FROM lines'
    // )

    // db.exec(`
    //     BEGIN TRANSACTION;
    //     CREATE TEMPORARY TABLE t1_backup(a,b);
    //     INSERT INTO t1_backup SELECT a,b FROM t1;
    //     DROP TABLE t1;
    //     CREATE TABLE t1(a,b);
    //     INSERT INTO t1 SELECT a,b FROM t1_backup;
    //     DROP TABLE t1_backup;
    //     COMMIT;
    // `)

    for (const hmm of db
        .prepare(
            'SELECT DISTINCT file, start, end from lines UNION ALL SELECT DISTINCT deffile, defstart, defstart from lines'
        )
        .all()) {
        docs.add(hmm.file)
        rangesByDoc.set(hmm.file, rangesByDoc.get(hmm.file) || new Set())
        const ranges = rangesByDoc.get(hmm.file)!
        const start = stringifyStringLocation({
            uri: hmm.file,
            range: { start: hmm.start },
        })
        ranges.add(start)
        locByRange.set(
            start,
            parseLocation(`${hmm.file}:${hmm.start}`, `${hmm.file}:${hmm.end}`)
        )
    }

    for (const hmm of db
        .prepare(
            'SELECT DISTINCT file, start, deffile, defstart, type from lines'
        )
        .all()) {
        const therefstart = stringifyStringLocation({
            uri: hmm.file,
            range: { start: hmm.start },
        })
        const thedefstart = stringifyStringLocation({
            uri: hmm.deffile,
            range: { start: hmm.defstart },
        })
        refsByDef.set(thedefstart, refsByDef.get(thedefstart) || new Set())
        const refs = refsByDef.get(thedefstart)!
        refs.add(therefstart)

        hoverByDef.set(thedefstart, hmm.type)
    }

    // refsByDef def keys ranges
    // locByRange

    await ffff({
        emit,
        root,
        inFileGlob,
        docs,
        rangesByDoc,
        refsByDef,
        hoverByDef,
        locByRange,
        importMonikerByRange,
        exportMonikerByRange,
    })
}

async function ffff({
    emit,
    root,
    inFileGlob,
    docs,
    rangesByDoc,
    refsByDef,
    hoverByDef,
    locByRange,
    importMonikerByRange,
    exportMonikerByRange,
}: {
    emit: Emit
    root: string
    inFileGlob: string

    docs: Set<Doc_>
    rangesByDoc: Map<Doc_, Set<Range_>>
    refsByDef: Map<Def_, Set<Ref_>>
    hoverByDef: Map<Def_, string>
    locByRange: Map<Range_, lsp.Location>
    importMonikerByRange: Map<
        Range_,
        { moniker: string; packageInformation: string }
    >
    exportMonikerByRange: Map<
        Range_,
        { moniker: string; packageInformation: string }
    >
}): Promise<void> {
    await emit(makeMeta(root, inFileGlob))
    await emit(makeProject())
    await emit(makeProjectBegin())

    for (const doc of Array.from(docs)) {
        await emitDocsBegin({ root, doc, emit })
    }

    for (const range of Array.from(locByRange.keys())) {
        const loc = locByRange.get(range)
        if (!loc) {
            throw new Error(
                `Unable to look up loc by range ${range} ${util.inspect(
                    locByRange
                )}`
            )
        }
        await emit(makeRange(loc))
    }

    await emitDefsRefsHovers({
        refsByDef,
        hoverByDef,
        locByRange,
        emit,
        importMonikerByRange,
        exportMonikerByRange,
    })

    await emitDocsEnd({ docs, rangesByDoc, emit })

    await emit<contains>({
        id: 'projectContains',
        type: ElementTypes.edge,
        label: EdgeLabels.contains,
        outV: 'project',
        inVs: Array.from(docs).map(doc => 'document:' + doc),
    })

    await emit(makeProjectEnd())
}

function stringifyLocation(loc: lsp.Location): string {
    return `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`
}

function stringifyStringLocation(loc: {
    uri: string
    range: { start: string }
}): string {
    return `${loc.uri}:${loc.range.start}`
}

interface Pos_ {
    line: number
    col: number
}

interface ImportRange {
    start: Pos_
    end: Pos_
}

function stringifyRange(range: ImportRange): string {
    return `${range.start.line}:${range.start.col}-${range.end.line}:${range.end.col}`
}

function stringifyPosition(pos: Pos_): string {
    return `${pos.line}:${pos.col}`
}

interface FilePosition {
    uri: string
    position: lsp.Position
}

type GenericEntry = { kind: string; value: Dictionary<string> }

type Link = (info: { def: lsp.Location; ref: lsp.Location }) => void

type RecordMoniker = (arg: {
    moniker: string
    range: string
    kind: MonikerKind
    packageInformation: string
}) => void

function makeRange(loc: lsp.Location): Range {
    return {
        id: stringifyLocation(loc),
        type: ElementTypes.vertex,
        label: VertexLabels.range,
        ...loc.range,
    }
}

async function emitDefsRefsHovers({
    refsByDef,
    hoverByDef,
    locByRange,
    emit,
    importMonikerByRange,
    exportMonikerByRange,
}: {
    refsByDef: Map<string, Set<string>>
    hoverByDef: Map<string, string>
    locByRange: Map<string, lsp.Location>
    emit: Emit
    importMonikerByRange: Map<
        string,
        { moniker: string; packageInformation: string }
    >
    exportMonikerByRange: Map<
        string,
        { moniker: string; packageInformation: string }
    >
}): Promise<void> {
    for (const [def, refs] of Array.from(refsByDef.entries())) {
        const defLoc = locByRange.get(def)
        if (!defLoc) {
            throw new Error('Unable to look up def')
        }

        //  ---14*packageEdge:$package---> (13*packageEdge:$package)
        // |
        // (11*moniker:export:$id) <---12*monikerEdge:export:$def
        //                                            \
        //                                            |
        //  ---2.3*packageEdge:$package---> (2.4*packageEdge:$package)
        // |                                          |
        // (2.2*moniker:import:$id) <---2.1*monikerEdge:import:$def
        //                                          \ |  ------------------------------------------------------------------
        //                                           \|/                                                                    \
        // ($def) ---2*next:$def---> 1*(resultSet:$def) ---7*textDocument/references:$def---> 6*(reference:$def) -------     \
        //  ^                                          \---4*textDocument/definition:$def---> 3*(definition:$def)   \    \    |
        //  |                                          \---?*textDocument/hover:$def---> ?*(hover:$def)         |    |    |   |
        //  |                                                                                /                 /     |    |   |
        //  |-------<---?*item:textDocument/hover:$def--------------------------------------                 /       |    |   |
        //  |-------<---5*item:textDocument/definition:$def-------------------------------------------------        /     |   |
        //  +-------<---8*item:textDocument/references:definitions:$def--------------------------------------------      /    |
        //          ----------------<---10*item:textDocument/references:references:$def:$*uri---------------------------     /
        //        /-------/-------------------9*next:$*ref--->--------------------------------------------------------------
        //       /       /
        // ($ref1) ($ref2) ...

        // 1
        await emit<ResultSet>({
            id: 'resultSet:' + def,
            label: VertexLabels.resultSet,
            type: ElementTypes.vertex,
        })

        // 2
        await emit<next>({
            id: 'next:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.next,
            outV: def,
            inV: 'resultSet:' + def,
        })

        const importMoniker = importMonikerByRange.get(def)
        if (importMoniker) {
            // 2.1
            await emit<Moniker>({
                id: 'moniker:import:' + def,
                label: VertexLabels.moniker,
                type: ElementTypes.vertex,
                identifier: importMoniker.moniker,
                kind: MonikerKind.import,
                scheme: 'cpp',
            })
            // 2.2
            await emit<moniker>({
                id: 'monikerEdge:import:' + def,
                label: EdgeLabels.moniker,
                type: ElementTypes.edge,
                inV: 'moniker:import:' + def,
                outV: 'resultSet:' + def,
            })
            // 2.3
            await emit<PackageInformation>({
                id: 'package:' + importMoniker.packageInformation,
                label: VertexLabels.packageInformation,
                type: ElementTypes.vertex,
                manager: 'cpp',
                name: importMoniker.packageInformation,
                version: '1.0',
            })
            // 2.4
            await emit<packageInformation>({
                id: 'packageEdge:' + importMoniker.packageInformation,
                label: EdgeLabels.packageInformation,
                type: ElementTypes.edge,
                inV: 'package:' + importMoniker.packageInformation,
                outV: 'moniker:import:' + def,
            })
        } else {
            // 3
            await emit<DefinitionResult>({
                id: 'definition:' + def,
                label: VertexLabels.definitionResult,
                type: ElementTypes.vertex,
            })

            // 4
            await emit<textDocument_definition>({
                id: 'textDocument/definition:' + def,
                type: ElementTypes.edge,
                label: EdgeLabels.textDocument_definition,
                outV: 'resultSet:' + def,
                inV: 'definition:' + def,
            })

            // 5
            await emit<item>({
                id: 'item:textDocument/definition:' + def,
                type: ElementTypes.edge,
                label: EdgeLabels.item,
                outV: 'definition:' + def,
                inVs: [def],
                document: 'document:' + defLoc.uri,
            })
        }

        const hover = hoverByDef.get(def)
        if (hover) {
            // ?
            await emit<HoverResult>({
                id: 'hover:' + def,
                label: VertexLabels.hoverResult,
                type: ElementTypes.vertex,
                result: { contents: hover },
            })

            // ?
            await emit<textDocument_hover>({
                id: 'textDocument/hover:' + def,
                type: ElementTypes.edge,
                label: EdgeLabels.textDocument_hover,
                outV: 'resultSet:' + def,
                inV: 'hover:' + def,
            })
        }

        // 6
        await emit<ReferenceResult>({
            id: 'reference:' + def,
            label: VertexLabels.referenceResult,
            type: ElementTypes.vertex,
        })

        // 7
        await emit<textDocument_references>({
            id: 'textDocument/references:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_references,
            outV: 'resultSet:' + def,
            inV: 'reference:' + def,
        })

        if (!importMoniker) {
            // 8
            await emit<item>({
                id: 'item:textDocument/references:definitions:' + def,
                type: ElementTypes.edge,
                label: EdgeLabels.item,
                outV: 'reference:' + def,
                inVs: [def],
                property: ItemEdgeProperties.definitions,
                document: 'document:' + defLoc.uri,
            })
        }

        // 9
        for (const ref of Array.from(refs)) {
            await emit<next>({
                id: 'next:' + ref,
                type: ElementTypes.edge,
                label: EdgeLabels.next,
                outV: ref,
                inV: 'resultSet:' + def,
            })
        }

        // 10
        for (const [uri, refsForCurrentUri] of toPairs(
            groupBy(Array.from(refs), ref => parseFilePosition(ref).uri)
        )) {
            await emit<item>({
                id:
                    'item:textDocument/references:references:' +
                    def +
                    ':' +
                    uri,
                type: ElementTypes.edge,
                label: EdgeLabels.item,
                outV: 'reference:' + def,
                inVs: Array.from(refsForCurrentUri),
                property: ItemEdgeProperties.references,
                document: 'document:' + uri,
            })
        }

        const exportMoniker = exportMonikerByRange.get(def)
        if (exportMoniker) {
            // 11
            await emit<Moniker>({
                id: 'moniker:export:' + def,
                label: VertexLabels.moniker,
                type: ElementTypes.vertex,
                identifier: exportMoniker.moniker,
                kind: MonikerKind.export,
                scheme: 'cpp',
            })
            // 12
            await emit<moniker>({
                id: 'monikerEdge:export:' + def,
                label: EdgeLabels.moniker,
                type: ElementTypes.edge,
                inV: 'moniker:export:' + def,
                outV: 'resultSet:' + def,
            })
            // 13
            await emit<PackageInformation>({
                id: 'package:' + exportMoniker.packageInformation,
                label: VertexLabels.packageInformation,
                type: ElementTypes.vertex,
                manager: 'cpp',
                name: exportMoniker.packageInformation,
                version: '1.0',
            })
            // 14
            await emit<packageInformation>({
                id: 'packageEdge:' + exportMoniker.packageInformation,
                label: EdgeLabels.packageInformation,
                type: ElementTypes.edge,
                inV: 'package:' + exportMoniker.packageInformation,
                outV: 'moniker:export:' + def,
            })
        }
    }
}

async function emitDocsEnd({
    docs,
    rangesByDoc,
    emit,
}: {
    docs: Set<string>
    rangesByDoc: Map<string, Set<string>>
    emit: Emit
}): Promise<void> {
    for (const doc of Array.from(docs)) {
        const ranges = rangesByDoc.get(doc)
        if (ranges === undefined) {
            throw new Error(
                `rangesByDoc didn't contain doc ${doc}, but contained ${Array.from(
                    rangesByDoc.keys()
                )}`
            )
        }

        await emit<contains>({
            id: 'contains:' + doc,
            type: ElementTypes.edge,
            label: EdgeLabels.contains,
            outV: 'document:' + doc,
            inVs: Array.from(ranges.keys()),
        })

        await emit<DocumentEvent>({
            id: 'documentEnd:' + doc,
            data: 'document:' + doc,
            type: ElementTypes.vertex,
            label: VertexLabels.event,
            kind: EventKind.end,
            scope: EventScope.document,
        })
    }
}

async function emitDocsBegin({
    root,
    doc,
    emit,
    includeContents = false,
}: {
    root: string
    doc: string
    emit: Emit
    includeContents?: boolean
}): Promise<void> {
    let contents = ''
    try {
        if (includeContents) {
            contents = fs.readFileSync(path.join(root, doc)).toString('base64')
        }
    } catch (e) {
        // ignore
    }
    await emit<Document>({
        id: 'document:' + doc,
        type: ElementTypes.vertex,
        label: VertexLabels.document,
        uri: 'file:///' + doc,
        languageId: 'cpp',
        contents,
    })
    await emit<DocumentEvent>({
        id: 'documentBegin:' + doc,
        data: 'document:' + doc,
        type: ElementTypes.vertex,
        label: VertexLabels.event,
        kind: EventKind.begin,
        scope: EventScope.document,
    })
}

function makeProjectEnd(): ProjectEvent {
    return {
        id: 'projectEnd',
        data: 'project',
        type: ElementTypes.vertex,
        label: VertexLabels.event,
        kind: EventKind.end,
        scope: EventScope.project,
    }
}

function makeProjectBegin(): ProjectEvent {
    return {
        id: 'projectBegin',
        data: 'project',
        type: ElementTypes.vertex,
        label: VertexLabels.event,
        kind: EventKind.begin,
        scope: EventScope.project,
    }
}

function makeProject(): Project {
    return {
        id: 'project',
        type: ElementTypes.vertex,
        label: VertexLabels.project,
        kind: 'cpp',
    }
}

function makeMeta(root: string, inFileGlob: string): MetaData {
    return {
        id: 'meta',
        type: ElementTypes.vertex,
        label: VertexLabels.metaData,
        projectRoot: 'file:///',
        version: '0.4.0',
        positionEncoding: 'utf-16',
        toolInfo: {
            name: 'lsif-cpp',
            args: [inFileGlob, root],
            version: 'dev',
        },
    }
}

function parseLocation(start: string, end: string): lsp.Location {
    const startP = parseFilePosition(start)
    const endP = parseFilePosition(end)
    if (startP.uri !== endP.uri) {
        throw new Error(
            `expected start and end of range to be in the same file, but were ${start} and ${end}`
        )
    }
    return {
        uri: startP.uri,
        range: {
            start: startP.position,
            end: endP.position,
        },
    }
}

function parseFilePosition(value: string): FilePosition {
    const components = value.split(':')
    if (components.length < 3) {
        throw new Error(
            `expected path of the form path/to/file.cpp:<line>:<column>, got ${value}`
        )
    }
    const line = parseInt(components[components.length - 2], 10)
    const character = parseInt(components[components.length - 1], 10)
    const path = components.slice(0, components.length - 2).join('')
    return {
        uri: path,
        position: { line, character },
    }
}
