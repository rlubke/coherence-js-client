import { IdentityExtractor } from "./identity_extractor";
import { ChainedExtractor, ValueExtractor } from "./value_extractor";
import { UniversalExtractor } from "./universal_extractor";
import { Util } from '../util/util';
import { MultiExtractor } from "./multi_extractor";
/**
 * Simple Extractor DSL.
 * 
 * @remarks
 * The methods in this class are for the most part simple factory methods for
 * various {@link ValueExtractor} classes, but in some cases provide additional type
 * safety. They also tend to make the code more readable, especially if imported
 * statically, so their use is strongly encouraged in lieu of direct construction
 * of {@link ValueExtractor} classes.
 */
export class Extractors {

    /**
     * Returns an extractor that extracts the specified fields or
     * extractors where extraction occurs in a chain where the result of each
     * field extraction is the input to the next extractor. The result
     * returned is the result of the final extractor in the chain.
     *
     * @param extractorsOrFields  If extractorsOrFields is a string[] type, then the 
     *                field names to extract (if any field name contains a dot '.'
     *                that field name is split into multiple field names delimiting on
     *                the dots. If extractorsOrFields is of ValueExtractor[] type,
     *                then the {@link ValueExtractor}s are used to extract the values.
     *
     * @param <T> the type of the object to extract from
     *
     * @return an extractor that extracts the value(s) of the specified field(s)
     *
     * @throws IllegalArgumentException if the fields parameter is null or an
     *         empty array
     *
     * @see UniversalExtractor
     */
    static chained<T, R>(...extractorsOrFields: ValueExtractor[] | string[]): ValueExtractor<T, R> {
        Util.ensureNotEmpty(extractorsOrFields, "The extractors or fields parameter cannot be null or empty");

        let extractors = new Array<ValueExtractor<T, R>>();
        if (extractorsOrFields && (typeof extractorsOrFields === 'string')) {
            for (let e of (extractorsOrFields as string[])) {
                if (e && e.length > 0) {    // filter null and empty
                    extractors.concat(Extractors.extract<T, R>(e));
                }
            }
        } else {
            extractors = extractorsOrFields as ValueExtractor[];
        }

        if (extractors.length == 1) {
            return extractors[0];
        }
        return new ChainedExtractor(extractors);

    }
    
    /**
     * Returns an extractor that extracts the value of the specified field.
     *
     * @param from    the name of the field or method to extract the value from.
     * @param params  the parameters to pass to the method.
     * @param <T>     the type of the object to extract from.
     * @param <E>     the type of the extracted value.
     *
     * @return an extractor that extracts the value of the specified field.
     *
     * @see UniversalExtractor
     */
    static extract<T, E>(from: string, params?: any[]): ValueExtractor<T, E> {
        if (params) {
            if (!from.endsWith(Util.METHOD_SUFFIX)) {
                from = from + Util.METHOD_SUFFIX;
            }
        }

        // return new UniversalExtractor(from, params);
        return new UniversalExtractor(from, params);
    }
    
    /**
     * Returns an extractor that always returns its input argument.
     *
     * @param <T> the type of the input and output objects to the function
     *
     * @return an extractor that always returns its input argument
     */
    static identity<T>(): ValueExtractor<T, T> {
        return new IdentityExtractor<T>();
    }

    /**
     * Returns an extractor that casts its input argument.
     *
     * @param <T> the type of the input objects to the function
     * @param <E> the type of the output objects to the function
     *
     * @return an extractor that always returns its input argument
     */
    static identityCast<T, E>(): ValueExtractor<T, E> {
        return IdentityExtractor.INSTANCE;
    }

    static multi<T>(...fields: string[]): ValueExtractor;
    static multi<T>(...extractors: ValueExtractor[]): ValueExtractor;
    static multi<T>(...fieldsOrExtractors:  ValueExtractor[] | string[]): ValueExtractor {
        Util.ensureNotEmpty(fieldsOrExtractors, 'fields or extractors array must not be null or empty');
        let extractors: ValueExtractor[] = new Array<ValueExtractor>();
        if (typeof fieldsOrExtractors[0] === 'string') {
            for (let f in fieldsOrExtractors) {
                extractors.push(Extractors.chained(f));
            }
        } else {
            extractors = fieldsOrExtractors as ValueExtractor[];
        }

        return new MultiExtractor(extractors);    // ??
    }

    private static isValueExtractor(e: any): e is ValueExtractor {
        return (e as ValueExtractor).getTarget !== undefined;
    }

}