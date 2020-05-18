/*
 * Copyright (c) 2020 Oracle and/or its affiliates.
 *
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * http://oss.oracle.com/licenses/upl.
 */

import { BaseProcessor } from './base_processor';
import { Filter } from '../filter/filter';

/**
 *  ReplaceValue entry processor.
 *
 * @param <K> the type of the Map entry key
 * @param <V> the type of the Map entry value
 */
export class ReplaceValueProcessor<K, V>
    extends BaseProcessor<K, V, void> {

    /**
     * Specifies the value that should exist in the Cache.
     */
    oldValue: V;

    /**
     * Specifies the new value that should be put in the Cache.
     */
    newValue: V;
    /**
     * Construct a ReplaceValue EntryProcessor.
     *
     * @param value   The value that must exiost in the Cache.
     */
    constructor(oldValue: V, newValue: V) {
        super('ReplaceValue');

        this.oldValue = oldValue;
        this.newValue = newValue;
    }
    
}
