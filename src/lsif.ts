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
import sqlite from 'better-sqlite3'

type Emit = <T extends Edge | Vertex>(item: T) => Promise<void>

type Doc_ = string
type Range_ = string
type Ref_ = Range_
type Def_ = Range_

export async function writeLSIF({
    inFile,
    root,
    emit,
    log = console.log,
}: {
    inFile: string
    root: string
    emit: Emit
    log?: (...args: any[]) => void
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

    try {
        // Remove old database file, if it exists
        fs.unlinkSync('scratch.db')
    } catch (e) {
        if (!(e && e.code === 'ENOENT')) {
            throw e
        }
    }

    const db = sqlite('scratch.db')
    db.pragma('foreign_keys = ON')
    db.pragma('synchronous = OFF')
    db.exec(`CREATE TABLE symbols (
            id INTEGER PRIMARY KEY,
            deffile TEXT NOT NULL,
            defline INTEGER NOT NULL,
            defstartcol INTEGER NOT NULL,
            defendcol INTEGER NOT NULL,
            hover TEXT,
            UNIQUE (deffile, defline, defstartcol, defendcol)
        )`)
    db.exec(`CREATE TABLE refs (
            reffile TEXT NOT NULL,
            refline INTEGER NOT NULL,
            refstartcol INTEGER NOT NULL,
            refendcol INTEGER NOT NULL,
            sid INTEGER NOT NULL,
            UNIQUE (reffile, refline, refstartcol, refendcol)
        )`)
    db.exec('CREATE INDEX ix_line ON refs(refline)')

    const symbol = db.prepare(
        'INSERT INTO symbols (id, deffile, defline, defstartcol, defendcol, hover) VALUES (@id, @deffile, @defline, @defstartcol, @defendcol, @hover)'
    )
    const filerefs = db.prepare(
        'INSERT INTO refs (reffile, refline, refstartcol, refendcol, sid) VALUES (@reffile, @refline, @refstartcol, @refendcol, @sid)'
    )

    log('Loading out.jsonl...')
    db.transaction(() => {
        let id = 0
        for (const line of fs
            .readFileSync(inFile)
            .toString()
            .split('\n')) {
            if (id % 1000 === 0) {
                log(id + ' ids loaded so far...')
            }
            if (line === '') {
                continue
            }

            const lineobj:
                | {
                      symbol: {
                          file: string
                          range: string
                          hover?: string
                      }
                  }
                | {
                      references: { file: string; ranges: string[] }
                  } = JSON.parse(line)
            if ('symbol' in lineobj) {
                id++
                const { file, range, hover } = lineobj.symbol
                symbol.run({
                    id,
                    deffile: file,
                    defline: range.split(':')[0],
                    defstartcol: range.split(':')[1].split('-')[0],
                    defendcol: range.split(':')[1].split('-')[1],
                    hover: hover,
                })
            } else {
                const { file, ranges } = lineobj.references
                for (const range of ranges) {
                    filerefs.run({
                        reffile: file,
                        refline: range.split(':')[0],
                        refstartcol: range.split(':')[1].split('-')[0],
                        refendcol: range.split(':')[1].split('-')[1],
                        sid: id,
                    })
                }
            }
        }
    })()

    log('Collecting ranges...')
    const results: {
        file: string
        line: number
        startcol: number
        endcol: number
    }[] = db
        .prepare(
            `
            SELECT DISTINCT deffile file, defline line, defstartcol startcol, defendcol endcol FROM symbols
            UNION ALL
            SELECT DISTINCT reffile file, refline line, refstartcol startcol, refendcol endcol FROM refs
        `
        )
        .all()
    for (const result of results) {
        docs.add(result.file)
        rangesByDoc.set(result.file, rangesByDoc.get(result.file) ?? new Set())
        const ranges = rangesByDoc.get(result.file)!
        const loc: lsp.Location = {
            uri: result.file,
            range: {
                start: { line: result.line, character: result.startcol },
                end: {
                    line: result.line /* all ranges are single-line */,
                    character: result.endcol,
                },
            },
        }
        const start = stringifyLocation(loc)
        ranges.add(start)
        locByRange.set(start, loc)
    }

    log('Linking defs and refs...')
    for (const result of db
        .prepare(
            `
            SELECT deffile, defline, defstartcol, defendcol, reffile, refline, refstartcol, refendcol, hover
            FROM refs JOIN symbols on refs.sid = symbols.id
            `
        )
        .all()) {
        const refstart = stringifyLocation({
            uri: result.reffile,
            range: {
                start: { line: result.refline, character: result.refstartcol },
                end: {
                    line: result.refline /* all ranges are single-line */,
                    character: result.refendcol,
                },
            },
        })
        const defstart = stringifyLocation({
            uri: result.deffile,
            range: {
                start: { line: result.defline, character: result.defstartcol },
                end: {
                    line: result.defline /* all ranges are single-line */,
                    character: result.defendcol,
                },
            },
        })
        refsByDef.set(defstart, refsByDef.get(defstart) ?? new Set())
        const refs = refsByDef.get(defstart)!
        refs.add(refstart)

        hoverByDef.set(defstart, result.hover)
    }

    log('Emitting...')
    await collectAndEmit({
        emit,
        root,
        inFile,
        docs,
        rangesByDoc,
        refsByDef,
        hoverByDef,
        locByRange,
        importMonikerByRange,
        exportMonikerByRange,
    })
}

// TODO share this with lsif-cpp
async function collectAndEmit({
    emit,
    root,
    inFile,
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
    inFile: string

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
    await emit(makeMeta(root, inFile))
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

interface Pos_ {
    line: number
    col: number
}

interface ImportRange {
    start: Pos_
    end: Pos_
}

interface FilePosition {
    uri: string
    position: lsp.Position
}

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
            throw new Error(
                `Unable to look up def ${def} in ${util.inspect(locByRange)}`
            )
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
