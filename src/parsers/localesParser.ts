import babelParser from '@babel/parser'
import { fs } from 'mz'
import path from 'path'
import EventEmitter from 'events'

import {
  ExportDefaultDeclaration,
  isExportDefaultDeclaration,
  isObjectExpression,
  isSpreadElement,
  isTSAsExpression,
  isObjectProperty,
  isStringLiteral,
  SpreadElement,
  isIdentifier,
  Statement,
  isImportDeclaration,
  isImportDefaultSpecifier
} from '@babel/types'

import { getLocaleFiles, getLang } from '@/src/helpers/fileUtil'
import { flatten } from '@/src/helpers/object'
import { ILocaleKey, ILocale } from '@/src/types'
import { LOCALE_PARSE_EVENTS } from '@/src/types/events'

export async function parseLocales(emitter: EventEmitter): Promise<ILocale[]> {
  const localeFilepaths = await getLocaleFiles()

  emitter.emit(LOCALE_PARSE_EVENTS.START, localeFilepaths)

  const localeFiles = flatten<string>(localeFilepaths)

  const localeKeys = await Promise.all(
    localeFiles.map(async l => {
      const data = await parseFileToLocale(l)

      emitter.emit(LOCALE_PARSE_EVENTS.PARSED, l)

      return data
    })
  )

  return localeKeys.map<ILocale>(d => ({
    lang: getLang(d[0].filePath),
    localeKeys: d
  }))
}

async function parseFileToLocale(filePath: string): Promise<ILocaleKey[]> {
  const code = await fs.readFile(filePath, { encoding: 'utf-8' })
  const ast = babelParser.parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'classProperties', 'dynamicImport', 'jsx', 'decorators-legacy']
  })

  const exportDefaultDeclaration = ast.program.body.find((n): n is ExportDefaultDeclaration =>
    isExportDefaultDeclaration(n)
  )

  if (!exportDefaultDeclaration) {
    return null
  }

  const defaultDeclaration = exportDefaultDeclaration.declaration
  const localeAst = isTSAsExpression(defaultDeclaration) ? defaultDeclaration.expression : defaultDeclaration

  if (!isObjectExpression(localeAst)) {
    return null
  }

  const result = await Promise.all(
    localeAst.properties
      .map(p => {
        let propLoc = p.loc
        let propKey: string = ''

        if (isObjectProperty(p)) {
          propKey = p.key.name
          if (isStringLiteral(p.key)) {
            propKey = p.key.value
            propLoc = p.key.loc
          }
        }
        if (isSpreadElement(p)) {
          return getSpreadProperties(filePath, p, ast.program.body)
        }
        if (!propLoc || !propKey) {
          return null
        }

        return Promise.resolve({
          key: propKey,
          loc: {
            startLine: propLoc.start.line,
            startLineColumn: propLoc.start.column,
            endLine: propLoc.end.line,
            endLineColumn: propLoc.end.column
          },
          filePath
        })
      })
      .filter((p): p is Promise<ILocaleKey> => !!p)
  )

  return flatten<ILocaleKey>(result)
}

async function getSpreadProperties(filePath: string, prop: SpreadElement, astbody: Statement[]) {
  const { argument } = prop
  if (!isIdentifier(argument)) {
    return []
  }
  const { name } = argument
  return await parseByIdentifier(filePath, name, astbody)
}

async function parseByIdentifier(filePath: string, identifier: string, astbody: Statement[]) {
  const found = astbody.find(a => {
    return (
      isImportDeclaration(a) &&
      a.specifiers.some(s => isImportDefaultSpecifier(s) && s.local.name === identifier)
    )
  })

  if (!found || !isImportDeclaration(found) || !isStringLiteral(found.source)) {
    return []
  }
  const filePathPrefix = path.join(path.dirname(filePath), found.source.value)
  const targetFiles = [filePathPrefix, `${filePathPrefix}.js`, `${filePathPrefix}.ts`]
  const targetFile = targetFiles.find(t => fs.existsSync(t))
  if (!targetFile) {
    return []
  }
  return await parseFileToLocale(targetFile)
}