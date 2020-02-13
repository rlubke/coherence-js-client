import { ValueManipulator } from "./value_manipulator";
import { ValueExtractor } from "../extractor/value_extractor";
import { ValueUpdater } from "../util/value_updater";
import { Util } from "../util/util";

export class PropertyManipulator<T = any, V = any>
    implements ValueManipulator<T, V> {

    '@class': string;

    name: string;

    useIsPrefix: boolean;

    /**
     * Construct a PropertyManipulator for the specified property name.
     * <p>
     * This constructor assumes that the corresponding property getter will
     * have a name of either ("get" + sName) or ("is + sName) and the
     * corresponding property setter's name will be ("set + sName).
     *
     * @param propertyName  a property name
     * @param useIs         if true, the getter method will be prefixed with "is"
     *                      rather than "get"
     */
    constructor(propertyName: string, useIs: boolean = false) {
        this['@class'] = Util.PROCESSOR_PACKAGE + 'PropertyManipulator';
        this.name = propertyName;
        this.useIsPrefix = useIs;
    }

    getExtractor(): ValueExtractor<T, V> {
        throw new Error("Method not implemented.");
    }

    getUpdater(): ValueUpdater<T, V> {
        throw new Error("Method not implemented.");
    }

}