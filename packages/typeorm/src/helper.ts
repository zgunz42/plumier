import { authorize, Class, entity } from "@plumier/core"
import reflect, { noop, useCache } from "@plumier/reflect"
import { getMetadataArgsStorage } from "typeorm"
import { parse } from "acorn"

function inverseSideParser(expr: ((t: any) => any)) {
    const node = parse(expr.toString(), { ecmaVersion: 2020 })
    return getMemberExpression(node)
}

function getContent(node: any): any {
    switch (node.type) {
        case "Program":
        case "BlockStatement":
            return node.body[node.body.length - 1]
        case "ArrowFunctionExpression":
            return node.body
        case "ExpressionStatement":
            return node.expression
        case "ReturnStatement":
            return node.argument
    }
}

function getMemberExpression(node: any): string {
    const content = getContent(node)
    if (content.type === "MemberExpression")
        return content.property.name
    else
        return getMemberExpression(content)
}


function normalizeEntityNoCache(type: Class) {
    const parent: Class = Object.getPrototypeOf(type)
    // loop through parent entities 
    if (!!parent.prototype) normalizeEntity(parent)
    const storage = getMetadataArgsStorage();
    const columns = storage.filterColumns(type)
    for (const col of columns) {
        Reflect.decorate([noop()], (col.target as Function).prototype, col.propertyName, void 0)
        if (col.options.primary)
            Reflect.decorate([entity.primaryId(), authorize.readonly()], (col.target as Function).prototype, col.propertyName, void 0)
    }
    const relations = storage.filterRelations(type)
    for (const col of relations) {
        const target = col.target as Function
        if (typeof col.type === "string")
            throw new Error(`Relation property ${target.name}.${col.propertyName} uses unsupported data type`)
        const rawType: Class = col.type()
        if (col.relationType === "many-to-many" || col.relationType === "one-to-many") {
            const inverse = col.inverseSideProperty!
            const inverseProperty = typeof inverse === "string" ? inverse : inverseSideParser(inverse)
            const decorators = [
                reflect.type(x => [rawType]),
                entity.relation({ inverseProperty }),
                authorize.readonly(),
                authorize.writeonly()
            ]
            Reflect.decorate(decorators, target.prototype, col.propertyName, void 0)
        }
        else {
            Reflect.decorate([reflect.type(x => rawType), entity.relation()], target.prototype, col.propertyName, void 0)
        }
    }
    return { success: true }
}

const normalizeEntityCache = new Map<Class, any>()

export const normalizeEntity = useCache(normalizeEntityCache, normalizeEntityNoCache, x => x)