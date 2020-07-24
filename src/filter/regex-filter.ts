/*
 * Copyright (c) 2020 Oracle and/or its affiliates.
 *
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * http://oss.oracle.com/licenses/upl.
 */

import { ValueExtractor } from '../extractor/'
import { ComparisonFilter } from '.'
import { internal } from './package-internal'

/**
 * Filter which returns true for {@link com.tangosol.util.InvocableMap.Entry}
 * objects that currently exist in a Map.
 * <p>
 * This Filter is intended to be used solely in combination with a
 * {@link com.tangosol.util.processor.ConditionalProcessor} and is unnecessary
 * for standard {@link com.tangosol.util.QueryMap} operations.
 *
 * @param <T> the type of the input argument to the filter
 *
 * @see com.tangosol.util.InvocableMap.Entry#isPresent()
 */
export class RegexFilter<T = any, E = any>
  extends ComparisonFilter<T, E, string> {
  constructor (methodOrExtractor: string | ValueExtractor<T, E>, regex: string) {
    super(internal.filterName('RegexFilter'), methodOrExtractor, regex)
  }
}