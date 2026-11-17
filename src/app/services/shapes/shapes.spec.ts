import { TestBed } from '@angular/core/testing';
import { Shapes } from './shapes';

describe('Shapes', () => {
  let service: Shapes;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Shapes);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
