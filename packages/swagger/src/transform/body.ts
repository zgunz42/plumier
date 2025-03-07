import { ApiHideRelationDecorator, FormFile, RouteInfo } from "@plumier/core"
import { ParameterReflection, PropertyReflection } from "@plumier/reflect"
import { ContentObject, ReferenceObject, RequestBodyObject, SchemaObject } from "openapi3-ts"

import { analyzeParameters, ParameterNode } from "./parameter"
import { SchemaOverrideType, transformTypeAdvance } from "./schema"
import { isPartialValidator, isRequired, TransformContext } from "./shared"


function transformJsonContent(schema: SchemaObject): ContentObject {
    return {
        "application/json": { schema },
        "application/x-www-form-urlencoded": { schema }
    }
}

function transformFileContent(schema: SchemaObject): ContentObject {
    return {
        "multipart/form-data": { schema },
    }
}

function getRequiredProps(props: (PropertyReflection | ParameterReflection)[] ) {
    const required = []
    for (const prop of props) {
        const isReq = !!prop.decorators.find(isRequired)
        if (isReq) required.push(prop.name)
    }
    return required.length > 0 ? required : undefined
}

function transformProperties(props: (PropertyReflection | ParameterReflection)[], ctx: TransformContext): SchemaObject {
    const properties = {} as { [propertyName: string]: (SchemaObject | ReferenceObject); }
    for (const prop of props) {
        properties[prop.name] = transformTypeAdvance(prop.type, ctx, { decorators: prop.decorators })
    }
    const required = getRequiredProps(props)
    const result: SchemaObject = { type: "object", properties, required }
    return result
}

function transformModel(model: ParameterNode, ctx: TransformContext) {
    const overrides: SchemaOverrideType[] = ["RelationAsId"]
    // if not partial validator then add required override
    if (!model.meta.decorators.find(isPartialValidator))
        overrides.push("Required")
    // if contains @api.noRelation() then adds remove all relations
    if (!!model.meta.decorators.find((x: ApiHideRelationDecorator) => x.kind === "ApiNoRelation")) {
        overrides.push("RemoveInverseProperty")
        overrides.push("RemoveArrayRelation")
    }
    overrides.push("ReadonlyFields")
    return transformTypeAdvance(model.type, ctx, { decorators: model.meta.decorators, overrides })
}

function transformJsonBody(nodes: ParameterNode[], ctx: TransformContext): RequestBodyObject | undefined {
    // decorator binding
    const body = nodes.find(x => x.binding?.name === "body")
    if (body) {
        const schema = transformModel(body, ctx)
        return { required: true, content: transformJsonContent(schema) }
    }
    // name binding
    const primitives = nodes.filter(x => x.typeName === "Primitive")
    if (primitives.length > 0 && primitives.length === nodes.length) {
        const schema = transformProperties(primitives.map(x => x.meta), ctx)
        return { required: true, content: transformJsonContent(schema) }
    }
    // model binding
    const model = nodes.find(x => x.typeName === "Array" || x.typeName === "Class")
    if (model) {
        const schema = transformModel(model, ctx)
        return { required: true, content: transformJsonContent(schema) }
    }
}

function transformFileBody(nodes: ParameterNode[], ctx: TransformContext): RequestBodyObject | undefined {
    const params: (ParameterReflection | PropertyReflection)[] = []
    for (const node of nodes) {
        // decorator binding
        if (node.binding?.name === "formFile") {
            // get field name from tag and force the type even if not specified in parameter
            const type = Array.isArray(node.type) ? [FormFile] : FormFile
            params.push({ ...node.meta, name: node.name, type })
        }
        else
            params.push(node.meta)
    }
    const schema = transformProperties(params, ctx)
    return { required: true, content: transformFileContent(schema) }
}

function transformBody(route: RouteInfo, ctx: TransformContext): RequestBodyObject | undefined {
    const isFormFile = (par: ParameterNode) => (Array.isArray(par.type) && par.type[0] === FormFile) || par.type === FormFile || par.binding?.name === "formFile"
    if (route.method !== "post" && route.method !== "put" && route.method !== "patch") return
    const pars = analyzeParameters(route)
        .filter(x => x.kind === "undecided")
        .filter(x => !["ctx", "request", "user", "custom"].some(y => y === x.binding?.name))
    if (pars.some(x => isFormFile(x)))
        return transformFileBody(pars, ctx)
    else
        return transformJsonBody(pars, ctx)
}

export { transformBody }
