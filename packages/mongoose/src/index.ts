import {
    Class,
    domain,
    Facility,
    isCustomClass,
    PlumierApplication,
    reflectPath,
    ValidatorDecorator,
    Converters,
    safeToString,
    TypeConverter,
} from "@plumjs/core";
import { ClassReflection, decorateClass, decorateParameter, ParameterReflection, reflect } from "@plumjs/reflect";
import { val } from "@plumjs/validator";
import Chalk from "chalk";
import Mongoose, { Model } from "mongoose";
import { dirname, isAbsolute, join } from "path";


/* ------------------------------------------------------------------------------- */
/* ------------------------------------ TYPES ------------------------------------ */
/* ------------------------------------------------------------------------------- */

export type Constructor<T> = new (...args: any[]) => T
export type SchemaRegistry = { [key: string]: Mongoose.Schema }
export interface MongooseFacilityOption {
    model?: string | Class | Class[]
    uri: string,
}
export interface SubSchema {
    type: typeof Mongoose.Schema.Types.ObjectId,
    ref: string
}
interface AnalysisResult {
    type: "warning" | "error",
    message: string
}
interface DomainAnalysis {
    domain: ClassReflection
    analysis: AnalysisResult[]
}
interface MongooseCollectionDecorator {
    type: "MongooseCollectionDecorator",
    alias?: string
}


const GlobalMongooseSchema: SchemaRegistry = {}
const ArrayHasNoTypeInfo = `MONG1000: Array property {0}.{1} require @array(<Type>) decorator to be able to generated into mongoose schema`
const NoClassFound = `MONG1001: No class decorated with @collection() found`
const CanNotValidateNonCollection = `MONG1002: @val.unique()  only can be applied to a class that mapped to mongodb collection, in class {0}.{1}`
const ModelNotDecoratedWithCollection = `MONG1003: {0} not decorated with @collection()`

/* ------------------------------------------------------------------------------- */
/* ------------------------------- SCHEMA GENERATOR ------------------------------ */
/* ------------------------------------------------------------------------------- */

function loadModels(opt: Class[]) {
    return opt.map(x => reflect(x))
}

function getType(prop: ParameterReflection, registry: SchemaRegistry): Function | Function[] | SubSchema | SubSchema[] {
    if (isCustomClass(prop.typeAnnotation)) {
        const schema = { type: Mongoose.Schema.Types.ObjectId, ref: "" }
        return Array.isArray(prop.typeAnnotation) ? [{ ...schema, ref: getName(prop.typeAnnotation[0]) }]
            : { ...schema, ref: getName(prop.typeAnnotation) }
    }
    else return prop.typeAnnotation
}

function generateModel(model: ClassReflection, registry: SchemaRegistry) {
    const schema = model.ctorParameters
        .reduce((a, b) => {
            a[b.name] = getType(b, registry)
            return a
        }, {} as any)
    registry[getName(model)] = new Mongoose.Schema(schema)
}

function generateSchema(opt: Class[], registry: SchemaRegistry) {
    loadModels(opt).forEach(x => generateModel(x, registry))
}

/* ------------------------------------------------------------------------------- */
/* --------------------------------- ANALYZER ------------------------------------ */
/* ------------------------------------------------------------------------------- */

function noArrayTypeInfoTest(domain: ClassReflection): AnalysisResult[] {
    return domain.ctorParameters
        .map(x => (x.typeAnnotation === Array) ?
            <AnalysisResult>{ message: ArrayHasNoTypeInfo.format(domain.name, x.name), type: "error" } : undefined)
        .filter((x): x is AnalysisResult => Boolean(x))
}

function analyze(domains: ClassReflection[]) {
    const tests = [noArrayTypeInfoTest]
    return domains.map(x => (<DomainAnalysis>{
        domain: x,
        analysis: tests.map(test => test(x)).flatten()
    }))
}

function printAnalysis(analysis: DomainAnalysis[]) {
    console.log()
    console.log(Chalk.bold("Model Analysis Report"))
    if (!analysis.map(x => x.domain).some(x =>
        x.decorators.some((y: MongooseCollectionDecorator) => y.type === "MongooseCollectionDecorator"))) {
        console.log(NoClassFound)
    }
    else {
        const namePad = Math.max(...analysis.map(x => x.domain.name.length))
        analysis.forEach((x, i) => {
            const num = (i + 1).toString().padStart(analysis.length.toString().length)
            const color = x.analysis.some(x => x.type === "error") ? Chalk.red : (x: string) => x
            console.log(color(`${num}. ${x.domain.name.padEnd(namePad)} -> ${getName(x.domain)}`))
            x.analysis.forEach(y => {
                console.log(Chalk.red(`  - ${y.type} ${y.message}`))
            })
        })
    }
}

/* ------------------------------------------------------------------------------- */
/* --------------------------------- HELPERS ------------------------------------- */
/* ------------------------------------------------------------------------------- */

async function isUnique(value: string, target: Class, index: number) {
    const meta = reflect(target)
    const field = meta.ctorParameters[index].name
    if (!meta.decorators.find((x: MongooseCollectionDecorator) => x.type === "MongooseCollectionDecorator"))
        throw new Error(CanNotValidateNonCollection.format(meta.name, field))
    const Model = model(target)
    const condition: { [key: string]: object } = {}
    //case insensitive comparison
    condition[field] = { $regex: value, $options: "i" }
    const result = await Model.findOne(condition)
    if (!!result) return `${value} already exists`
}

/* ------------------------------------------------------------------------------- */
/* ------------------------------- MAIN FUNCTIONS -------------------------------- */
/* ------------------------------------------------------------------------------- */

declare module "@plumjs/validator" {
    namespace val {
        function unique(): (target: any, name: string, index: number) => void
    }
}

val.unique = () => {
    return decorateParameter((target, name, index) => {
        const createValidator = (target: Class, index: number) => (value: string) => isUnique(value, target, index)
        return <ValidatorDecorator>{
            type: "ValidatorDecorator",
            name: "mongoose:unique",
            validator: createValidator(target, index)
        }
    })
}

export function collection(alias?: string) {
    return decorateClass(<MongooseCollectionDecorator>{ type: "MongooseCollectionDecorator", alias })
}

export function getName(opt: ClassReflection | Class) {
    const meta = typeof opt === "function" ? reflect(opt) : opt
    const decorator = meta.decorators.find((x: MongooseCollectionDecorator): x is MongooseCollectionDecorator => x.type === "MongooseCollectionDecorator")
    return decorator && decorator.alias || meta.name
}

/**
 * Custom model converter to allow relational data using mongoose ObjectId
 */
export function customModelConverter(value: any, path: string[], expectedType: Function | Function[], converters: Converters) {
    const strObject = safeToString(value)
    if (Mongoose.Types.ObjectId.isValid(strObject)) {
        return Mongoose.Types.ObjectId(strObject)
    }
    else {
        return converters.default["Object"](value, path, expectedType, converters)
    }
}

export class MongooseFacility implements Facility {
    option: MongooseFacilityOption
    constructor(opts: MongooseFacilityOption) {
        const model = opts.model || "./model"
        const domain = typeof model === "string" ? isAbsolute(model) ?
            model! : join(dirname(module.parent!.filename), model) : model
        this.option = { ...opts, model: domain }
    }

    async setup(app: Readonly<PlumierApplication>) {
        //generate schemas
        const collections = reflectPath(this.option.model!)
            .filter((x): x is ClassReflection => x.type === "Class")
            .filter(x => x.decorators.some((x: MongooseCollectionDecorator) => x.type == "MongooseCollectionDecorator"))
        if (app.config.mode === "debug") {
            const analysis = analyze(collections)
            printAnalysis(analysis)
        }
        generateSchema(collections.map(x => x.object), GlobalMongooseSchema)
        //register custom converter
        const converters = app.config.converters || []
        app.set({
            converters: converters.concat(collections
                .map(x => <TypeConverter>{ type: x.object, converter: customModelConverter }))
        })
        await Mongoose.connect(this.option.uri, { useNewUrlParser: true })
    }
}

export function model<T extends object>(type: Constructor<T>) {
    class ModelProxyHandler<T extends object> implements ProxyHandler<Mongoose.Model<T & Mongoose.Document>> {
        private isLoaded = false
        modelName: string;
        metaData: ClassReflection

        constructor(domain: Constructor<T>) {
            const meta = reflect(domain)
            this.modelName = getName(meta)
            this.metaData = meta
        }

        private getModelByName(name: string): Mongoose.Model<T & Mongoose.Document> {
            if (!Mongoose.connection.models[name])
                return Mongoose.model(name, GlobalMongooseSchema[name])
            else
                return Mongoose.model(name)
        }

        private getModel(): Mongoose.Model<T & Mongoose.Document> {
            if (!this.isLoaded) {
                const properties = this.metaData.ctorParameters
                    .filter(x => isCustomClass(x.typeAnnotation))
                    .map((x) => <Class>(Array.isArray(x.typeAnnotation) ? x.typeAnnotation[0] : x.typeAnnotation))
                const unique = Array.from(new Set(properties))
                unique.forEach(x => this.getModelByName(getName(x)))
                this.isLoaded = true
            }
            return this.getModelByName(this.modelName)
        }

        get(target: Mongoose.Model<T & Mongoose.Document>, p: PropertyKey, receiver: any): any {
            if (GlobalMongooseSchema[this.modelName]) {
                const Model = this.getModel();
                return (Model as any)[p]
            }
            else {
                return p === "toString" ? () => "[Function]" : (target as any)[p]
            }
        }

        construct?(target: Mongoose.Model<T & Mongoose.Document>, argArray: any, newTarget?: any): object {
            try {
                const Model = this.getModel();
                return new Model(...argArray)
            } catch (e) {
                throw new Error(ModelNotDecoratedWithCollection.format(this.modelName))
            }
        }
    }
    return new Proxy(Mongoose.Model as Mongoose.Model<T & Mongoose.Document>, new ModelProxyHandler<T>(type))
}
