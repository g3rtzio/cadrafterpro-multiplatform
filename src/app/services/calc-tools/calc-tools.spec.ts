import { TestBed } from '@angular/core/testing';
import { CalcTools } from './calc-tools';

describe('CalcTools', () => {
  let service: CalcTools;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CalcTools);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
