import { TestBed } from '@angular/core/testing';
import { EstimateLayouts } from './estimate-layouts';

describe('EstimateLayouts', () => {
  let service: EstimateLayouts;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(EstimateLayouts);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
