import { ClassReflection, ParameterReflection, PropertyReflection, reflect, reflection } from "@plumier/reflect"
import debug from "debug"

import { Class, entityHelper, isCustomClass } from "./common"
import { ResponseTypeDecorator } from "./decorator/common"
import { EntityIdDecorator, RelationDecorator } from "./decorator/entity"
import { HttpStatus } from "./http-status"
import {
    AccessModifier,
    ActionContext,
    ActionResult,
    AuthorizationContext,
    Authorizer,
    AuthPolicy,
    Configuration,
    HttpStatusError,
    Invocation,
    Metadata,
    MetadataImpl,
    Middleware,
    RouteAnalyzerFunction,
    RouteAnalyzerIssue,
    RouteInfo,
    RouteMetadata,
} from "./types"

// --------------------------------------------------------------------- //
// ------------------------------- TYPES ------------------------------- //
// --------------------------------------------------------------------- //


const log = {
    debug: debug("@plumier/core:authorization"),
}

type AuthorizerFunction = (info: AuthorizationContext) => boolean | Promise<boolean>

interface AuthorizeDecorator {
    type: "plumier-meta:authorize",
    policies: string[]
    access: AccessModifier
    tag: string,
    location: "Class" | "Parameter" | "Method",
    evaluation: "Static" | "Dynamic",
    appliedClass: Class
}

type CustomAuthorizer = Authorizer
type CustomAuthorizerFunction = AuthorizerFunction
type AuthorizerContext = AuthorizationContext

/* ------------------------------------------------------------------------------- */
/* ------------------------------- HELPERS --------------------------------------- */
/* ------------------------------------------------------------------------------- */

function createDecoratorFilter(predicate: (x: AuthorizeDecorator) => boolean) {
    return (x: AuthorizeDecorator): x is AuthorizeDecorator => x.type === "plumier-meta:authorize" && predicate(x)
}

function getGlobalDecorators(globalDecorator: string | string[]) {
    const policies = typeof globalDecorator === "string" ? [globalDecorator] : globalDecorator
    return [<AuthorizeDecorator>{
        type: "plumier-meta:authorize",
        policies,
        tag: policies.join("|"),
        access: "route",
        evaluation: "Dynamic",
        location: "Method",
        appliedClass: Object
    }]
}

function getRouteAuthorizeDecorators(info: RouteInfo, globalDecorator?: string | string[]) {
    // if action has decorators then return immediately to prioritize the action decorator
    const actionDecs = info.action.decorators.filter(createDecoratorFilter(x => x.access === "route"))
    if (actionDecs.length > 0) return actionDecs
    // if controller has decorators then return immediately
    const controllerDecs = info.controller.decorators.filter(createDecoratorFilter(x => x.access === "route"))
    if (controllerDecs.length > 0) return controllerDecs
    if (!globalDecorator) return []
    return getGlobalDecorators(globalDecorator)
}

function createAuthContext(ctx: ActionContext, access: AccessModifier): AuthorizationContext {
    const { route, state } = ctx
    return <AuthorizationContext>{
        user: state.user, route, ctx, access, policyIds: [],
        metadata: new MetadataImpl(ctx.parameters, ctx.route, {} as any),
    }
}

function throwAuthError(ctx: AuthorizerContext, msg?: string) {
    if (!ctx.user) throw new HttpStatusError(HttpStatus.Forbidden, msg ?? "Forbidden")
    else throw new HttpStatusError(HttpStatus.Unauthorized, msg ?? "Unauthorized")
}

function getErrorLocation(metadata: Metadata) {
    const current = metadata.current!
    if (current.kind === "Class")
        return `class ${current.name}`
    return `${current.kind.toLowerCase()} ${current.parent!.name}.${current.name}`
}

// --------------------------------------------------------------------- //
// ------------------------ AUTHORIZATION POLICY ----------------------- //
// --------------------------------------------------------------------- //

const Public = "Public"
const Authenticated = "Authenticated"
const AuthorizeReadonly = "plumier::readonly"
const AuthorizeWriteonly = "plumier::writeonly"
type EntityProviderQuery<T = any> = (entity: Class, id: any) => Promise<T>
interface EntityPolicyProviderDecorator { kind: "plumier-meta:entity-policy-provider", entity: Class, idParam: string }
type EntityPolicyAuthorizerFunction = (ctx: AuthorizerContext, id: any) => boolean | Promise<boolean>

class PolicyAuthorizer implements Authorizer {
    constructor(private policies: Class<AuthPolicy>[], private keys: string[]) { }
    async authorize(ctx: AuthorizationContext): Promise<boolean> {
        for (const Auth of this.policies.reverse()) {
            const authPolicy = new Auth()
            for (const policy of this.keys) {
                if (authPolicy.equals(policy, ctx)) {
                    const authorize = await authPolicy.authorize(ctx)
                    log.debug("%s -> %s.%s by %s",
                        authorize ? "AUTHORIZED" : "FORBIDDEN",
                        ctx.metadata.current!.parent?.name ?? "",
                        ctx.metadata.current!.name,
                        authPolicy.friendlyName())
                    if (authorize) return true
                }
            }
        }
        return false
    }
}

class CustomAuthPolicy implements AuthPolicy {
    constructor(public name: string, private authorizer: CustomAuthorizerFunction | CustomAuthorizer) { }
    equals(id: string, ctx: AuthorizationContext): boolean {
        return id === this.name
    }
    async authorize(ctx: AuthorizationContext): Promise<boolean> {
        try {
            if (typeof this.authorizer === "function")
                return await this.authorizer(ctx)
            else
                return await this.authorizer.authorize(ctx)
        }
        catch (e) {
            const message = e instanceof Error ? e.stack : e
            const location = getErrorLocation(ctx.metadata)
            throw new Error(`Error occur inside authorization policy ${this.name} on ${location} \n ${message}`)
        }
    }
    conflict(other: AuthPolicy): boolean {
        return this.name === other.name
    }
    friendlyName() {
        return `AuthPolicy { name: "${this.name}" }`
    }
}

class PublicAuthPolicy extends CustomAuthPolicy {
    constructor() { super(Public, {} as any) }
    async authorize(ctx: AuthorizationContext): Promise<boolean> {
        return true
    }
}

class AuthenticatedAuthPolicy extends CustomAuthPolicy {
    constructor() { super(Authenticated, {} as any) }
    async authorize(ctx: AuthorizationContext): Promise<boolean> {
        return !!ctx.user
    }
}

class ReadonlyAuthPolicy extends CustomAuthPolicy {
    constructor() { super(AuthorizeReadonly, {} as any) }
    async authorize(ctx: AuthorizationContext): Promise<boolean> {
        return false
    }
}

class WriteonlyAuthPolicy extends CustomAuthPolicy {
    constructor() { super(AuthorizeWriteonly, {} as any) }
    async authorize(ctx: AuthorizationContext): Promise<boolean> {
        return false
    }
}

class EntityAuthPolicy<T> implements AuthPolicy {
    constructor(public name: string, public entity: Class<T>, private authorizer: EntityPolicyAuthorizerFunction) { }
    private getEntity(ctx: AuthorizerContext): { entity: Class, id: any } {
        if (ctx.access === "route" || ctx.access === "write") {
            // when the entity provider is Route 
            // take the provided Entity from decorator 
            // take the entity ID value from the Action Parameter
            const dec: EntityPolicyProviderDecorator | undefined = ctx.metadata.action.decorators
                .find((x: EntityPolicyProviderDecorator) => x.kind === "plumier-meta:entity-policy-provider")
            if (!dec) {
                const meta = ctx.metadata
                throw new Error(`Action ${meta.controller.name}.${meta.action.name} doesn't have Entity Policy Provider information`)
            }
            const id = ctx.metadata.actionParams!.get(dec.idParam)
            return { entity: dec.entity, id }
        }
        else {
            // when the entity provider is Read/Write/Filter
            // take the provided entity from the parent type from context
            // take the entity ID value using @primaryId() decorator
            const entity = ctx.metadata.current!.parent!
            const prop = entityHelper.getIdProp(entity)
            if (!prop)
                throw new Error(`Entity ${entity.name} doesn't have primary ID information required for entity policy`)
            const id = ctx.parentValue[prop.name]
            return { entity, id }
        }
    }
    equals(id: string, ctx: AuthorizationContext): boolean {
        if (id === this.name) {
            const provider = this.getEntity(ctx)
            return this.entity === provider.entity
        }
        return false
    }
    async authorize(ctx: AuthorizationContext): Promise<boolean> {
        const provider = this.getEntity(ctx)
        try {
            return await this.authorizer(ctx, provider.id)
        }
        catch (e) {
            const message = e instanceof Error ? e.stack : e
            const location = getErrorLocation(ctx.metadata)
            throw new Error(`Error occur inside authorization policy ${this.name} for entity ${this.entity.name} on ${location} \n ${message}`)
        }
    }
    conflict(other: AuthPolicy): boolean {
        if (other instanceof EntityAuthPolicy)
            return this.name === other.name && this.entity === other.entity
        else
            return this.name === other.name
    }
    friendlyName() {
        return `EntityPolicy { name: "${this.name}", entity: ${this.entity.name} }`
    }
}

class AuthPolicyBuilder {
    constructor(private globalCache: Class<AuthPolicy>[]) { }

    /**
     * Define AuthPolicy class on the fly
     * @param id Id of the authorization policy that will be used in @authorize decorator
     * @param authorizer Authorization logic, a lambda function return true to authorize otherwise false
     */
    define(id: string, authorizer: CustomAuthorizerFunction | CustomAuthorizer): Class<AuthPolicy> {
        class Policy extends CustomAuthPolicy {
            constructor() { super(id, authorizer) }
        }
        return Policy
    }

    /**
     * Register authorization policy into authorization cache
     * @param id Id of the authorization policy that will be used in @authorize decorator
     * @param authorizer Authorization logic, a lambda function return true to authorize otherwise false
     */
    register(id: string, authorizer: CustomAuthorizerFunction | CustomAuthorizer): AuthPolicyBuilder {
        const Policy = this.define(id, authorizer)
        this.globalCache.push(Policy)
        return this
    }
}

class EntityPolicyBuilder<T> {
    constructor(private entity: Class<T>, private globalCache: Class<AuthPolicy>[]) { }

    /**
     * Define AuthPolicy class on the fly
     * @param id Id of the authorization policy that will be used in @authorize decorator
     * @param authorizer Authorization logic, a lambda function return true to authorize otherwise false
     */
    define(id: string, authorizer: EntityPolicyAuthorizerFunction): Class<AuthPolicy> {
        const entity = this.entity
        class Policy extends EntityAuthPolicy<T> {
            constructor() { super(id, entity, authorizer) }
        }
        return Policy
    }

    /**
     * Register authorization policy into authorization cache
     * @param id Id of the authorization policy that will be used in @authorize decorator
     * @param authorizer Authorization logic, a lambda function return true to authorize otherwise false
     */
    register(id: string, authorizer: EntityPolicyAuthorizerFunction): EntityPolicyBuilder<T> {
        const Policy = this.define(id, authorizer)
        this.globalCache.push(Policy)
        return this
    }
}

const globalPolicies: Class<AuthPolicy>[] = []

function authPolicy() {
    return new AuthPolicyBuilder(globalPolicies)
}

function entityPolicy<T>(entity: Class<T>) {
    return new EntityPolicyBuilder<T>(entity, globalPolicies)
}

// --------------------------------------------------------------------- //
// ---------------------- MAIN AUTHORIZER FUNCTION --------------------- //
// --------------------------------------------------------------------- //

function executeAuthorizer(decorator: AuthorizeDecorator | AuthorizeDecorator[], info: AuthorizationContext) {
    const policies = Array.isArray(decorator) ? decorator.map(x => x.policies).flatten() : decorator.policies
    const instance = new PolicyAuthorizer(info.ctx.config.authPolicies, policies)
    return instance.authorize(info)
}

// --------------------------------------------------------------------- //
// ----------------- CONTROLLER OR ACTION AUTHORIZATION ---------------- //
// --------------------------------------------------------------------- //

function fixContext(decorator: AuthorizeDecorator, info: AuthorizerContext) {
    if (decorator.location === "Class") {
        info.metadata.current = info.ctx.route.controller
    }
    if (decorator.location === "Method") {
        info.metadata.current = { ...info.ctx.route.action, parent: info.ctx.route.controller.type }
    }
    return info
}

async function checkUserAccessToRoute(decorators: AuthorizeDecorator[], info: AuthorizationContext) {
    const conditions = await Promise.all(decorators.map(x => executeAuthorizer(x, fixContext(x, info))))
    // if authorized once then pass
    if (conditions.some(x => x === true)) return
    // if not then throw error accordingly
    throwAuthError(info)
}

// --------------------------------------------------------------------- //
// ---------------------- PARAMETER AUTHORIZATION ---------------------- //
// --------------------------------------------------------------------- //

interface ParamCheckContext {
    path: string[]
    info: AuthorizationContext
    parent: Class
    parentValue?: any
}

function createContext(ctx: ParamCheckContext, value: any, meta: ClassReflection | PropertyReflection | ParameterReflection) {
    const info = { ...ctx.info }
    const metadata = { ...info.metadata }
    metadata.current = { ...meta, parent: ctx.parent }
    info.value = value
    info.parentValue = ctx.parentValue
    info.metadata = metadata
    return info
}

async function checkParameter(meta: PropertyReflection | ParameterReflection, value: any, ctx: ParamCheckContext): Promise<string[]> {
    if (value === undefined || value === null) return []
    // skip check on GET method
    if (ctx.info.ctx.method === "GET") return []
    const decorators = meta.decorators.filter(createDecoratorFilter(x => x.access === "write"))
    if (decorators.length > 0) {
        const info = createContext(ctx, value, meta)
        const allowed = await executeAuthorizer(decorators, info)
        if (!allowed) return [ctx.path.join(".")]
    }
    // if the property is a relation property just skip checking, since we allow set relation using ID
    const isRelation = meta.decorators.some((x: RelationDecorator) => x.kind === "plumier-meta:relation")
    if (isRelation) return []
    // loop through property of type array
    if (Array.isArray(meta.type)) {
        const newMeta = { ...meta, type: meta.type[0] };
        const result: string[] = []
        for (let i = 0; i < value.length; i++) {
            const val = value[i];
            result.push(...await checkParameter(newMeta, val, { ...ctx, path: ctx.path.concat(i.toString()) }))
        }
        return result
    }
    // loop through custom class properties
    if (isCustomClass(meta.type)) {
        const classMeta = reflect(<Class>meta.type)
        const values = classMeta.properties.map(x => value[x.name])
        return checkParameters(classMeta.properties, values, { ...ctx, parent: meta.type, parentValue: value })
    }
    // everything when fine then just return []
    return []
}

async function checkParameters(meta: (PropertyReflection | ParameterReflection)[], value: any[], ctx: ParamCheckContext) {
    const result: string[] = []
    for (let i = 0; i < meta.length; i++) {
        const prop = meta[i];
        const issues = await checkParameter(prop, value[i], { ...ctx, path: ctx.path.concat(prop.name), })
        result.push(...issues)
    }
    return result
}

async function checkUserAccessToParameters(meta: ParameterReflection[], values: any[], info: AuthorizationContext) {
    const unauthorizedPaths = await checkParameters(meta, values, { info, path: [], parent: info.ctx.route.controller.type })
    if (unauthorizedPaths.length > 0)
        throwAuthError(info, `Unauthorized to populate parameter paths (${unauthorizedPaths.join(", ")})`)
}

// --------------------------------------------------------------------- //
// ----------------------- RESPONSE AUTHORIZATION ---------------------- //
// --------------------------------------------------------------------- //


type FilterNode = ArrayNode | ClassNode | ValueNode

interface ValueNode {
    kind: "Value"
}

interface ArrayNode {
    kind: "Array"
    child: FilterNode
}

interface ClassNode {
    kind: "Class"
    properties: {
        name: string,
        meta: PropertyReflection & { parent?: Class },
        authorizer: boolean | Authorizer,
        type: FilterNode
    }[]
}

async function createPropertyNode(prop: PropertyReflection, info: AuthorizerContext) {
    const decorators = prop.decorators.filter(createDecoratorFilter(x => x.access === "read"))
    let policies = []
    for (const dec of decorators) {
        policies.push(...dec.policies)
    }
    // if no authorize decorator then always allow to access
    const authorizer = policies.length === 0 ? true : new PolicyAuthorizer(info.ctx.config.authPolicies, policies)
    return { name: prop.name, authorizer }
}

async function compileType(type: Class | Class[], ctx: AuthorizerContext, parentTypes: Class[]): Promise<FilterNode> {
    if (Array.isArray(type)) {
        return { kind: "Array", child: await compileType(type[0], ctx, parentTypes) }
    }
    else if (isCustomClass(type)) {
        // CIRCULAR: just return basic node if circular dependency happened
        if (parentTypes.some(x => x === type)) return { kind: "Class", properties: [] }
        const meta = reflect(type)
        const properties = []
        for (const prop of meta.properties) {
            const meta = { ...prop, parent: type }
            const propCtx = { ...ctx, metadata: new MetadataImpl(ctx.ctx.parameters, ctx.ctx.route, meta) }
            const propNode = await createPropertyNode(prop, propCtx)
            properties.push({
                ...propNode, meta,
                type: await compileType(prop.type, propCtx, parentTypes.concat(type))
            })
        }
        return { kind: "Class", properties }
    }
    else return { kind: "Value" }
}

async function getAuthorize(authorizers: boolean | Authorizer, ctx: AuthorizerContext) {
    if (typeof authorizers === "boolean") return authorizers
    return authorizers.authorize(ctx)
}

async function filterType(raw: any, node: FilterNode, ctx: AuthorizerContext): Promise<any> {
    if (node.kind === "Array") {
        const result = []
        if (!Array.isArray(raw))
            throw new Error(`Action ${ctx.ctx.route.controller.name}.${ctx.ctx.route.action.name} expecting return value of type Array but got ${raw.constructor.name}`)
        for (const item of raw) {
            const val = await filterType(item, node.child, ctx)
            if (val !== undefined)
                result.push(val)
        }
        return result.length === 0 ? undefined : result
    }
    else if (node.kind === "Class") {
        const result: any = {}
        for (const prop of node.properties) {
            const value = raw[prop.name]
            if (value === null || value === undefined) continue
            const authorized = await getAuthorize(prop.authorizer, {
                ...ctx, value,
                parentValue: raw,
                metadata: { ...ctx.metadata, current: prop.meta }
            })
            if (authorized) {
                const candidate = await filterType(value, prop.type, ctx)
                const transform = ctx.ctx.config.responseTransformer ?? ((a, b) => b)
                const val = transform(prop.meta, candidate)
                if (val !== undefined)
                    result[prop.name] = val
            }
        }
        return Object.keys(result).length === 0 && result.constructor === Object ? undefined : result
    }
    else return raw
}

async function responseAuthorize(raw: ActionResult, ctx: ActionContext): Promise<ActionResult> {
    const getType = (resp: ResponseTypeDecorator | undefined) => {
        return !!resp ? (reflection.isCallback(resp.type) ? resp.type({}) : resp.type) as (Class | Class[]) : undefined
    }
    const responseType = ctx.route.action.decorators.find((x: ResponseTypeDecorator): x is ResponseTypeDecorator => x.kind === "plumier-meta:response-type")
    const type = getType(responseType) ?? ctx.route.action.returnType
    if (type !== Promise && type && raw.status === 200 && raw.body) {
        const info = createAuthContext(ctx, "read")
        const node = await compileType(type, info, [])
        raw.body = Array.isArray(raw.body) && raw.body.length === 0 ? [] : await filterType(raw.body, node, info)
        return raw
    }
    else {
        return raw;
    }
}


// --------------------------------------------------------------------- //
// ----------------------------- MIDDLEWARE ---------------------------- //
// --------------------------------------------------------------------- //


async function checkAuthorize(ctx: ActionContext) {
    if (ctx.config.enableAuthorization) {
        const { route, parameters, config } = ctx
        const info = createAuthContext(ctx, "route")
        const decorator = getRouteAuthorizeDecorators(route, config.globalAuthorizations)
        //check user access
        await checkUserAccessToRoute(decorator, info)
        //if ok check parameter access
        await checkUserAccessToParameters(route.action.parameters, parameters, { ...info, access: "write" })
    }
}

class AuthorizerMiddleware implements Middleware {
    constructor() { }
    async execute(invocation: Readonly<Invocation<ActionContext>>): Promise<ActionResult> {
        Object.assign(invocation.ctx, { user: invocation.ctx.state.user })
        await checkAuthorize(invocation.ctx)
        const result = await invocation.proceed()
        return responseAuthorize(result, invocation.ctx)
    }
}

export {
    AuthorizerFunction, Authorizer, checkAuthorize, AuthorizeDecorator,
    getRouteAuthorizeDecorators, AuthorizerMiddleware,
    CustomAuthorizer, CustomAuthorizerFunction, AuthorizationContext, AuthorizerContext,
    AccessModifier, EntityPolicyProviderDecorator, EntityProviderQuery, PublicAuthPolicy, AuthenticatedAuthPolicy,
    authPolicy, entityPolicy, EntityPolicyAuthorizerFunction, PolicyAuthorizer, Public, Authenticated,
    AuthPolicy, CustomAuthPolicy, EntityAuthPolicy, globalPolicies,
    AuthorizeReadonly, AuthorizeWriteonly, ReadonlyAuthPolicy, WriteonlyAuthPolicy,
    createAuthContext, executeAuthorizer, throwAuthError
}
